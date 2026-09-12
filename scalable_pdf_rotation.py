import os
# Force all child processes and CUDA to exclusively use GPU 0
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["FLAGS_fraction_of_gpu_memory_to_use"] = "0.05"

import sys
import logging
import json
import time
import subprocess
import cv2
import numpy as np
from collections import Counter
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

def analyze_page_rotation(pdf_path, page_num):
    """
    Worker function to analyze a single page perfectly using PaddleOCR internals.
    1. Detect text bounding boxes.
    2. Analyze aspect ratio to find 90/270 rotations.
    3. Use text_recognizer on cropped boxes to resolve 90 vs 270.
    4. Use text_classifier on cropped boxes to resolve 0 vs 180.
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
                return page_num, meta_rot, "metadata"
        
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
        
        # Run full OCR on each rotated page. 
        # This completely fixes the issue where text_detector draws bad horizontal boxes on sideways tables.
        for angle, img in imgs.items():
            result = _ocr_model.ocr(img, cls=False)
            if not result or not result[0]:
                confs[angle] = 0.0
                continue
                
            # Filter out garbage text AND vertically oriented text boxes!
            # If the page is sideways, the text boxes will be taller than they are wide.
            # By only counting horizontal boxes, the wrong orientations will score 0!
            valid_confs = []
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
                    
            confs[angle] = sum(valid_confs)
            
        best_rot = max(confs, key=confs.get)
        max_score = confs[best_rot]
        
        # SAFETY CHECK 1: If the highest score is very low, the model is guessing blindly
        # SAFETY CHECK 2: Bias towards 0 degrees if the best rotation's score is within 
        # 2.0 points of the 0 degree score. (Reduced from 5.0 since we now filter garbage).
        if max_score < 5.0:
            print(f"--> Page {page_num} scores too low (max {max_score:.1f}). Defaulting to 0 deg.", flush=True)
            detected_angle = 0
        elif best_rot != 0 and (max_score - confs[0]) < 2.0:
            print(f"--> Page {page_num} {best_rot} deg ({max_score:.1f}) is too close to 0 deg ({confs[0]:.1f}). Penalizing and defaulting to 0 deg.", flush=True)
            detected_angle = 0
        else:
            # If best_rot is the angle we had to ROTATE it by to make it readable, 
            # then the page's current detected orientation is (360 - best_rot) % 360.
            detected_angle = (360 - best_rot) % 360
        
        print(f"--> Page {page_num} confs: 0={confs[0]:.1f}, 90={confs[90]:.1f}, 180={confs[180]:.1f}, 270={confs[270]:.1f} -> {detected_angle} deg", flush=True)
        
        return page_num, detected_angle, "universal_recognizer"
            
    except Exception as e:
        logger.error(f"Error processing page {page_num}: {e}")  
        return page_num, 0, "error"

def _analyze_page_wrapper(args):
    """Wrapper to allow unpacking tuple arguments for multiprocessing.Pool and return pdf_path"""
    pdf_path, page_num = args
    page_num, angle, method = analyze_page_rotation(pdf_path, page_num)
    return pdf_path, page_num, angle, method

def _save_completed_pdf(input_pdf, output_pdf, page_rotations):
    """Helper to apply rotations and save a fully completed PDF."""
    try:
        logger.info(f"Applying corrections and saving to {output_pdf}...")
        doc = fitz.open(input_pdf)
        summary = Counter()
        
        for page_num in range(doc.page_count):
            page = doc.load_page(page_num)
            detected_angle, method = page_rotations.get(page_num, (0, "default"))
            summary[f"{detected_angle}_degrees_via_{method}"] += 1
            
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
        
        for k, v in summary.items():
            logger.info(f"  {os.path.basename(input_pdf)} - {k}: {v} pages")
            
    except Exception as e:
        logger.error(f"Failed to save {output_pdf}: {e}")

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
    completed_files = 0

    # Phase 2: Process pages as fast as possible in parallel
    with multiprocessing.Pool(processes=num_workers, initializer=init_worker, initargs=(use_gpu, gpu_mem)) as pool:
        # imap_unordered pulls tasks dynamically and returns results as soon as they finish
        for result in pool.imap_unordered(_analyze_page_wrapper, tasks):
            pdf_path, page_num, angle, method = result
            
            tracker = pdf_tracker[pdf_path]
            tracker["rotations"][page_num] = (angle, method)
            tracker["completed_pages"] += 1
            
            filename = os.path.basename(pdf_path)
            files_status[filename] = f"processing ({tracker['completed_pages']}/{tracker['total_pages']})"
            
            if progress_callback:
                # Provide real-time UI updates
                progress_callback(completed_files, len(pdf_files), filename, files_status)
                
            # TRIGGER ASYNC SAVE: Is this PDF fully complete?
            if tracker["completed_pages"] == tracker["total_pages"]:
                rel_path = os.path.relpath(pdf_path, input_folder)
                output_pdf = os.path.join(output_folder, rel_path)
                
                # Apply rotations and save to disk
                _save_completed_pdf(pdf_path, output_pdf, tracker["rotations"])
                
                # Record final angles for the final return dictionary
                all_page_rotations[filename] = {p: rot[0] for p, rot in tracker["rotations"].items()}
                
                # Cleanup tracker to instantly free memory
                del pdf_tracker[pdf_path]
                
                completed_files += 1
                files_status[filename] = "done"
                
                if progress_callback:
                    progress_callback(completed_files, len(pdf_files), filename, files_status)
    
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
        "page_rotations": all_page_rotations
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
