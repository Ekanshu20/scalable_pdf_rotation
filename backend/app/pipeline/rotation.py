import os
# Force all child processes and CUDA to exclusively use GPU 0
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["FLAGS_fraction_of_gpu_memory_to_use"] = "0.05"

import sys
import logging
import json
import time
import subprocess
import signal
import threading
import cv2
import numpy as np
from collections import Counter, deque
from concurrent.futures import ProcessPoolExecutor, as_completed
import multiprocessing
import fitz  # PyMuPDF

def get_straight_crop_image(img, points):
    assert len(points) == 4, "shape of points must be 4*2"
    img_crop_width = int(
        max(
            np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])
        )
    )
    img_crop_height = int(
        max(
            np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])
        )
    )
    pts_std = np.float32(
        [
            [0, 0],
            [img_crop_width, 0],
            [img_crop_width, img_crop_height],
            [0, img_crop_height],
        ]
    )
    M = cv2.getPerspectiveTransform(points, pts_std)
    dst_img = cv2.warpPerspective(
        img,
        M,
        (img_crop_width, img_crop_height),
        borderMode=cv2.BORDER_REPLICATE,
        flags=cv2.INTER_CUBIC,
    )
    # Intentionally removed auto-rotation logic here to preserve absolute pixel orientation
    return dst_img

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(processName)s - %(message)s')
logger = logging.getLogger(__name__)

# Global variable to hold the model instance in each worker
# This prevents loading the model into memory multiple times in the same process
_ocr_model = None

def init_worker(use_gpu=False, gpu_mem=2000):
    """
    Initializes the PaddleOCR model once per worker process.
    This saves massive amounts of overhead by keeping the model loaded in RAM.
    """
    global _ocr_model
    try:
        from paddleocr import PaddleOCR
        
        # Initialize paddle OCR with only the tools we need to save memory
        _ocr_model = PaddleOCR(
            use_angle_cls=True, 
            lang='en', 
            use_gpu=use_gpu, 
            gpu_mem=gpu_mem, # Extremely important for multi-processing on GPU!
            enable_mkldnn=False,
            cpu_threads=1, 
            show_log=False 
        )
            
        logger.info(f"PaddleOCR model loaded into memory successfully (GPU: {use_gpu}).")
    except Exception as e:
        logger.error(f"Failed to load PaddleOCR in worker: {e}")
        sys.exit(1)

# A page is flagged for human review when the model was effectively guessing.
LOW_SCORE_THRESHOLD = 5.0   # nothing readable found at any rotation
ZERO_BIAS_MARGIN = 2.0      # best rotation barely beat leaving the page alone
AMBIGUOUS_RATIO = 0.25      # winner didn't clearly beat the runner-up

RENDER_DPI = 100.0          # analysis render resolution
BLANK_INK_RATIO = 0.002     # below this share of dark pixels the page is effectively blank
SKEW_REPORT_DEGREES = 0.75  # tilt worth telling the user about

def _ink_ratio(img_bgr):
    """Share of dark pixels - used to tell a blank page from one OCR simply couldn't read."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    return float(np.count_nonzero(gray < 200)) / float(gray.size or 1)

def _skew_degrees(lines):
    """
    Median tilt of the detected text baselines. PaddleOCR already gives us a polygon per
    text line, so fine skew comes free - no Hough transform or extra pass needed.
    Positive means the text runs downhill to the right.
    """
    angles = []
    for box, _text, _conf in lines:
        (x0, y0), (x1, y1) = box[0], box[1]
        dx, dy = x1 - x0, y1 - y0
        if abs(dx) < 1:
            continue
        angle = np.degrees(np.arctan2(dy, dx))
        # Only near-horizontal baselines describe page skew
        if abs(angle) <= 20:
            angles.append(angle)
    return round(float(np.median(angles)), 2) if angles else 0.0

def _unrotate_point(x, y, angle, width, height):
    """
    Map a point from the rotated (readable) image back to the original render.
    width/height are the ORIGINAL image dimensions.
    """
    if angle == 90:      # image was rotated clockwise; origin moved to the right edge
        return y, height - x
    if angle == 180:
        return width - x, height - y
    if angle == 270:     # counter-clockwise
        return width - y, x
    return x, y

def analyze_page_rotation(pdf_path, page_num):
    """
    Worker function to analyze a single page perfectly using PaddleOCR internals.
    1. Detect text bounding boxes.
    2. Analyze aspect ratio to find 90/270 rotations.
    3. Use text_recognizer on cropped boxes to resolve 90 vs 270.
    4. Use text_classifier on cropped boxes to resolve 0 vs 180.

    Returns (page_num, detected_angle, method, details) where details carries the
    per-rotation scores and whether a human should look at this page.
    """

    try:
        doc = fitz.open(pdf_path)
        page = doc.load_page(page_num)

        # 1. Check existing PDF metadata first!
        page_dict = page.get_text("dict")
        if isinstance(page_dict, dict) and "Rotate" in page_dict:
            meta_rot = page_dict["Rotate"]
            if meta_rot != 0 and meta_rot % 90 == 0:
                logger.info(f"Page {page_num} relies on metadata rotation: {meta_rot}")
                return page_num, meta_rot, "metadata", {"scores": {}, "needs_review": False, "reason": None}, []
        
        # Render the page to a low-res image for quick ML inference
        matrix = fitz.Matrix(100 / 72.0, 100 / 72.0)
        pix = page.get_pixmap(matrix=matrix, alpha=False)
        img_array = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
        img_bgr_0 = img_array[:, :, ::-1]
        
        # Create full page rotations
        img_bgr_90 = cv2.rotate(img_bgr_0, cv2.ROTATE_90_CLOCKWISE)
        img_bgr_180 = cv2.rotate(img_bgr_0, cv2.ROTATE_180)
        img_bgr_270 = cv2.rotate(img_bgr_0, cv2.ROTATE_90_COUNTERCLOCKWISE)
        
        imgs = {0: img_bgr_0, 90: img_bgr_90, 180: img_bgr_180, 270: img_bgr_270}
        confs = {}
        recognized = {}

        # Run full OCR on each rotated page.
        # This completely fixes the issue where text_detector draws bad horizontal boxes on sideways tables.
        for angle, img in imgs.items():
            result = _ocr_model.ocr(img, cls=False)
            if not result or not result[0]:
                confs[angle] = 0.0
                recognized[angle] = []
                continue

            # Filter out garbage text AND vertically oriented text boxes!
            # If the page is sideways, the text boxes will be taller than they are wide.
            # By only counting horizontal boxes, the wrong orientations will score 0!
            valid_confs = []
            lines = []
            for line in result[0]:
                if not line[1] or line[1][1] <= 0.6:
                    continue

                box = line[0]
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                w = max(xs) - min(xs)
                h = max(ys) - min(ys)

                # Horizontal text should be wider than it is tall.
                # We use w > h * 0.8 to safely allow single square characters (like "1" or "A")
                if w > h * 0.8:
                    valid_confs.append(line[1][1])
                    # Keep what was actually read - this is the text layer that makes the
                    # output PDF searchable, and it costs nothing extra to retain.
                    lines.append((box, line[1][0], line[1][1]))

            confs[angle] = sum(valid_confs)
            recognized[angle] = lines

        best_rot = max(confs, key=confs.get)
        max_score = confs[best_rot]
        runner_up = sorted(confs.values(), reverse=True)[1]

        needs_review = False
        reason = None

        # SAFETY CHECK 1: If the highest score is very low, the model is guessing blindly
        # SAFETY CHECK 2: Bias towards 0 degrees if the best rotation's score is within
        # ZERO_BIAS_MARGIN of the 0 degree score.
        if max_score < LOW_SCORE_THRESHOLD:
            print(f"--> Page {page_num} scores too low (max {max_score:.1f}). Defaulting to 0 deg.", flush=True)
            detected_angle = 0
            needs_review = True
            reason = "no_text"
        elif best_rot != 0 and (max_score - confs[0]) < ZERO_BIAS_MARGIN:
            print(f"--> Page {page_num} {best_rot} deg ({max_score:.1f}) is too close to 0 deg ({confs[0]:.1f}). Penalizing and defaulting to 0 deg.", flush=True)
            detected_angle = 0
            needs_review = True
            reason = "close_to_zero"
        else:
            # If best_rot is the angle we had to ROTATE it by to make it readable,
            # then the page's current detected orientation is (360 - best_rot) % 360.
            detected_angle = (360 - best_rot) % 360
            if runner_up > 0 and (max_score - runner_up) / max_score < AMBIGUOUS_RATIO:
                needs_review = True
                reason = "ambiguous"

        print(f"--> Page {page_num} confs: 0={confs[0]:.1f}, 90={confs[90]:.1f}, 180={confs[180]:.1f}, 270={confs[270]:.1f} -> {detected_angle} deg", flush=True)

        # --- Text layer, blank detection, skew (all derived from work already done) ---
        best_lines = recognized.get(best_rot, [])
        ink = _ink_ratio(img_bgr_0)
        is_blank = ink < BLANK_INK_RATIO
        skew = _skew_degrees(best_lines)

        # A page with no readable text is only genuinely "blank" if there's no ink either;
        # otherwise it's a scan OCR couldn't read, which is a different problem.
        if is_blank:
            needs_review = True
            reason = "blank"
        elif abs(skew) >= SKEW_REPORT_DEGREES and not needs_review:
            needs_review = True
            reason = "skewed"

        # Map every line back to PDF points in the page's own coordinate space
        h0, w0 = img_bgr_0.shape[:2]
        scale = 72.0 / RENDER_DPI
        text_layer = []
        for box, text, conf in best_lines:
            pts = [_unrotate_point(px, py, best_rot, w0, h0) for px, py in box]
            xs = [p[0] * scale for p in pts]
            ys = [p[1] * scale for p in pts]
            text_layer.append({
                "text": text,
                "conf": round(float(conf), 3),
                "rect": [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            })

        details = {
            "scores": {str(angle): round(score, 1) for angle, score in confs.items()},
            "needs_review": needs_review,
            "reason": reason,
            "skew": skew,
            "ink_ratio": round(ink, 5),
            "word_count": sum(len(l["text"].split()) for l in text_layer),
        }
        return page_num, detected_angle, "universal_recognizer", details, text_layer

    except Exception as e:
        logger.error(f"Error processing page {page_num}: {e}")
        return page_num, 0, "error", {"scores": {}, "needs_review": True, "reason": "error"}, []

def _analyze_page_wrapper(args):
    """Wrapper to allow unpacking tuple arguments for multiprocessing.Pool and return pdf_path"""
    pdf_path, page_num = args
    page_num, angle, method, details, text_layer = analyze_page_rotation(pdf_path, page_num)
    return pdf_path, page_num, angle, method, details, text_layer

def _insert_text_layer(page, lines):
    """
    Write the recognised text into the page as invisible glyphs (render mode 3), the
    standard way to make a scan searchable: the image still displays, but the text is
    selectable, copyable and indexable.
    """
    added = 0
    for line in lines:
        text = (line.get("text") or "").strip()
        rect = line.get("rect")
        if not text or not rect:
            continue

        box = fitz.Rect(*rect)
        if box.is_empty or box.height <= 0 or box.width <= 0:
            continue

        # Scale the font so the string spans the detected box width. insert_textbox is
        # the wrong tool here - it refuses to draw anything when the text doesn't fit
        # (returning a negative number), and OCR lines rarely fit at their natural size.
        # insert_text just draws at a baseline, which is what a text layer needs, and it
        # keeps selection aligned with the underlying image.
        fontsize = box.height * 0.9
        try:
            natural = fitz.get_text_length(text, fontname="helv", fontsize=fontsize)
            if natural > 0:
                fontsize *= box.width / natural
            fontsize = max(min(fontsize, 100.0), 0.5)

            page.insert_text(
                (box.x0, box.y1 - box.height * 0.15),   # baseline, allowing for descenders
                text,
                fontname="helv",
                fontsize=fontsize,
                render_mode=3,          # invisible: image still shows, text is selectable
            )
            added += 1
        except Exception:
            continue
    return added

def _save_completed_pdf(input_pdf, output_pdf, page_rotations, page_text=None):
    """Helper to apply rotations and save a fully completed PDF."""
    try:
        logger.info(f"Applying corrections and saving to {output_pdf}...")
        doc = fitz.open(input_pdf)
        summary = Counter()
        page_text = page_text or {}
        text_lines_added = 0

        for page_num in range(doc.page_count):
            page = doc.load_page(page_num)
            detected_angle, method = page_rotations.get(page_num, (0, "default"))
            summary[f"{detected_angle}_degrees_via_{method}"] += 1

            # Insert the searchable layer BEFORE rotating: the coordinates were mapped
            # back into the page's own unrotated space.
            lines = page_text.get(page_num)
            if lines:
                text_lines_added += _insert_text_layer(page, lines)

            if detected_angle != 0:
                current_metadata_rot = page.rotation
                if method == "metadata":
                    page.set_rotation(0)
                else:
                    new_rotation = (current_metadata_rot - detected_angle) % 360
                    page.set_rotation(new_rotation)

        os.makedirs(os.path.dirname(output_pdf), exist_ok=True)
        doc.save(output_pdf)
        doc.close()
        
        if text_lines_added:
            logger.info(f"  {os.path.basename(input_pdf)} - searchable text layer: {text_lines_added} lines")
        for k, v in summary.items():
            logger.info(f"  {os.path.basename(input_pdf)} - {k}: {v} pages")
            
    except Exception as e:
        logger.error(f"Failed to save {output_pdf}: {e}")

POOL_SHUTDOWN_TIMEOUT = 20

def _shutdown_pool(pool, timeout=POOL_SHUTDOWN_TIMEOUT):
    """
    Tear the worker pool down with a hard deadline.

    PaddlePaddle's CUDA runtime can block forever destroying its context when it gets
    the SIGTERM that Pool.terminate() sends. That hangs the *parent* too, so the Celery
    task never reports a result and the worker stops consuming its queue - the job looks
    stuck even though its output was already written.

    Every page result has been collected and every PDF saved by the time we get here, so
    there is nothing left to lose: give the children a bounded chance to exit, then kill
    them. CUDA state dies with the process.
    """
    pool.terminate()

    joiner = threading.Thread(target=pool.join, daemon=True)
    joiner.start()
    joiner.join(timeout)

    if not joiner.is_alive():
        return

    logger.warning(
        f"Worker pool did not exit within {timeout}s (PaddlePaddle CUDA teardown). "
        f"Killing child processes so the job can report its result."
    )
    for child in getattr(pool, "_pool", []):
        try:
            if child.is_alive():
                os.kill(child.pid, signal.SIGKILL)
        except Exception:
            pass

def _get_gpu_memory_mb():
    """Total VRAM (MB) of GPU 0, via nvidia-smi. Returns None if it can't be determined."""
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            timeout=5,
        )
        return int(output.decode().strip().splitlines()[0])
    except Exception:
        return None


def _cap_gpu_workers(requested_workers, gpu_mem_per_worker):
    """
    Each worker process loads its own PaddleOCR models and reserves a gpu_mem-sized
    CUDA memory pool independently (see init_worker). Requesting more workers than
    the card can actually hold doesn't fail cleanly - it oversubscribes the GPU and
    causes hangs / fatal CUDA aborts (observed in practice on a 4GB laptop GPU with
    num_workers=6-10). Reserve 25% of VRAM as headroom for model weights, driver
    overhead, and anything else already using the card.
    """
    total_mem = _get_gpu_memory_mb()
    if not total_mem or gpu_mem_per_worker <= 0:
        return requested_workers  # Can't introspect the GPU; trust the caller.

    safe_budget = total_mem * 0.75
    max_workers = max(1, int(safe_budget // gpu_mem_per_worker))
    return min(requested_workers, max_workers)


def run_rotation_pipeline(input_folder, output_folder, use_gpu=True, gpu_mem=1500, num_workers=6, progress_callback=None):
    if not os.path.exists(input_folder):
        logger.error(f"Cannot find input folder: {input_folder}")
        return {"error": f"Input folder {input_folder} does not exist", "status": "failed"}

    # REQUIRED for CUDA in Python multiprocessing on Linux!
    if use_gpu and multiprocessing.get_start_method(allow_none=True) != 'spawn':
        multiprocessing.set_start_method('spawn', force=True)
            
    logger.info("=========================================")
    logger.info(f"Starting Scalable PDF Rotation Pipeline")
    logger.info(f"System Cores: {os.cpu_count()}")
    logger.info(f"Using GPU: {use_gpu}")
    logger.info(f"Allocated Workers: {num_workers}")
    logger.info("=========================================")
    
    pdf_files = []
    for root, dirs, files in os.walk(input_folder):
        for f in files:
            if f.lower().endswith('.pdf'):
                pdf_files.append(os.path.join(root, f))
                
    if not pdf_files:
        logger.warning(f"No PDF files found in {input_folder}")
        return {"error": "No PDFs found", "status": "completed", "files_processed": 0}
        
    overall_start_time = time.time()
    
    # Phase 1: Discover all PDFs and flatten into a global page task pool
    logger.info("Phase 1: Discovering pages across all PDFs...")
    tasks = []
    pdf_tracker = {}
    total_pages_found = 0
    
    for file_idx, input_pdf in enumerate(pdf_files):
        filename = os.path.basename(input_pdf)
        try:
            doc = fitz.open(input_pdf)
            total_pages = doc.page_count
            doc.close()
            
            pdf_tracker[input_pdf] = {
                "total_pages": total_pages,
                "completed_pages": 0,
                "rotations": {},
                "details": {},
                "text": {},
                "file_idx": file_idx
            }
            total_pages_found += total_pages
            
            for p in range(total_pages):
                tasks.append((input_pdf, p))
                
        except Exception as e:
            logger.error(f"Failed to open {input_pdf}: {e}")
            if progress_callback:
                progress_callback(file_idx + 1, len(pdf_files), filename, {"status": "failed"})

    logger.info(f"Found {len(pdf_files)} PDFs with a total of {total_pages_found} pages.")

    # Don't spin up more worker processes than there are pages to process.
    num_workers = max(1, min(num_workers, len(tasks)))

    if use_gpu:
        capped_workers = _cap_gpu_workers(num_workers, gpu_mem)
        if capped_workers < num_workers:
            logger.warning(
                f"Requested {num_workers} GPU workers, but only ~{capped_workers} fit in "
                f"available VRAM at {gpu_mem}MB/worker. Capping to {capped_workers} to avoid "
                f"GPU out-of-memory hangs/crashes."
            )
        num_workers = capped_workers

    logger.info(f"Phase 2: Processing global pool of pages asynchronously with {num_workers} worker(s)...")

    files_status = {os.path.basename(f): "queued" for f in pdf_files}
    all_page_rotations = {}
    all_page_details = {}
    completed_files = 0
    completed_pages = 0

    # Timestamps of recent page completions. A sliding window measures the *current*
    # throughput; a cumulative average would permanently include the model warm-up
    # (several seconds before the first page lands) and stay pessimistic all run.
    recent_completions = deque(maxlen=30)

    def _progress_stats():
        """ETA from observed throughput - adapts to GPU/CPU, worker count and page size."""
        now = time.time()
        elapsed = now - overall_start_time
        remaining = total_pages_found - completed_pages

        rate = 0
        if len(recent_completions) >= 2:
            window = recent_completions[-1] - recent_completions[0]
            if window > 0:
                rate = (len(recent_completions) - 1) / window

        return {
            "completed_pages": completed_pages,
            "total_pages": total_pages_found,
            "elapsed_seconds": round(elapsed, 1),
            "pages_per_second": round(rate, 3),
            # Stays null until there's enough signal to be honest about it
            "eta_seconds": round(remaining / rate) if rate > 0 and remaining > 0 else (0 if remaining == 0 else None),
        }

    # Phase 2: Process pages as fast as possible in parallel.
    # Deliberately not a `with` block: its __exit__ calls terminate() and then joins
    # without any timeout, which is exactly where CUDA teardown can wedge the process.
    pool = multiprocessing.Pool(processes=num_workers, initializer=init_worker, initargs=(use_gpu, gpu_mem))
    try:
        # imap_unordered pulls tasks dynamically and returns results as soon as they finish
        for result in pool.imap_unordered(_analyze_page_wrapper, tasks):
            pdf_path, page_num, angle, method, details, text_layer = result

            tracker = pdf_tracker[pdf_path]
            tracker["rotations"][page_num] = (angle, method)
            tracker["details"][page_num] = details
            tracker["text"][page_num] = text_layer
            tracker["completed_pages"] += 1
            completed_pages += 1
            recent_completions.append(time.time())

            filename = os.path.basename(pdf_path)
            files_status[filename] = f"processing ({tracker['completed_pages']}/{tracker['total_pages']})"

            if progress_callback:
                # Provide real-time UI updates
                progress_callback(completed_files, len(pdf_files), filename, files_status, _progress_stats())

            # TRIGGER ASYNC SAVE: Is this PDF fully complete?
            if tracker["completed_pages"] == tracker["total_pages"]:
                rel_path = os.path.relpath(pdf_path, input_folder)
                output_pdf = os.path.join(output_folder, rel_path)
                
                # Apply rotations and save to disk
                _save_completed_pdf(pdf_path, output_pdf, tracker["rotations"], tracker["text"])
                
                # Record final angles for the final return dictionary
                all_page_rotations[filename] = {p: rot[0] for p, rot in tracker["rotations"].items()}
                all_page_details[filename] = {
                    p: {**tracker["details"].get(p, {}), "angle": rot[0], "method": rot[1]}
                    for p, rot in tracker["rotations"].items()
                }

                # Cleanup tracker to instantly free memory
                del pdf_tracker[pdf_path]
                
                completed_files += 1
                files_status[filename] = "done"

                if progress_callback:
                    progress_callback(completed_files, len(pdf_files), filename, files_status, _progress_stats())
    finally:
        _shutdown_pool(pool)

    overall_end_time = time.time()
    total_time = overall_end_time - overall_start_time
    logger.info("======= FINAL ROTATION SUMMARY ==========")
    logger.info(f"Total PDFs processed: {completed_files}")
    logger.info(f"Total Pages processed: {total_pages_found}")
    logger.info(f"Total processing time: {total_time:.2f} seconds")
    logger.info("=========================================")
    
    return {
        "status": "completed",
        "files_processed": completed_files,
        "pages_processed": total_pages_found,
        "time_seconds": total_time,
        "page_rotations": all_page_rotations,
        "page_details": all_page_details
    }

def main():
    import argparse
    parser = argparse.ArgumentParser(description="Scalable PDF Rotation")
    parser.add_argument("--input", "-i", type=str, required=True, help="Path to input folder containing PDFs")
    parser.add_argument("--output", "-o", type=str, required=True, help="Path to output folder for rotated PDFs")
    parser.add_argument("--use-gpu", action="store_true", help="Enable GPU processing")
    parser.add_argument("--gpu-mem", type=int, default=1500, help="GPU memory to allocate per worker in MB")
    parser.add_argument("--workers", type=int, default=1, help="Number of concurrent workers")
    args = parser.parse_args()

    run_rotation_pipeline(args.input, args.output, args.use_gpu, args.gpu_mem, args.workers)

if __name__ == '__main__':
    multiprocessing.freeze_support()
    main()
