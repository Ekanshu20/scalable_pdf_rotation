import os
# Force all child processes and CUDA to exclusively use GPU 0
os.environ["CUDA_VISIBLE_DEVICES"] = "0"
os.environ["FLAGS_fraction_of_gpu_memory_to_use"] = "0.05"

import sys
import logging
import json
import time
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
    global _ocr_model
    
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
        img_bgr = img_array[:, :, ::-1]
        
        # 2. Get Bounding Boxes using the internal text_detector
        dt_boxes, _ = _ocr_model.text_detector(img_bgr)
        
        if dt_boxes is None or len(dt_boxes) == 0:
            return page_num, 0, "no_text_found"
            
        # To save huge amounts of time, we only run the heavy ML on the top 15 largest text boxes
        box_sizes = [np.linalg.norm(b[0]-b[1]) * np.linalg.norm(b[1]-b[2]) for b in dt_boxes]
        top_indices = np.argsort(box_sizes)[-15:]
        sample_boxes = [dt_boxes[i] for i in top_indices]
        
        # Crop the image patches WITHOUT auto-rotating vertical text!
        img_crop_list_0 = [get_straight_crop_image(img_bgr, np.array(box, dtype=np.float32)) for box in sample_boxes]
        
        # Generate the other 3 rotations
        img_crop_list_90 = [cv2.rotate(crop, cv2.ROTATE_90_CLOCKWISE) for crop in img_crop_list_0]
        img_crop_list_180 = [cv2.rotate(crop, cv2.ROTATE_180) for crop in img_crop_list_0]
        img_crop_list_270 = [cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE) for crop in img_crop_list_0]
        
        # Run text_recognizer on all sets
        rec_res_0, _ = _ocr_model.text_recognizer(img_crop_list_0)
        rec_res_90, _ = _ocr_model.text_recognizer(img_crop_list_90)
        rec_res_180, _ = _ocr_model.text_recognizer(img_crop_list_180)
        rec_res_270, _ = _ocr_model.text_recognizer(img_crop_list_270)
        
        # Sum up the confidence scores
        conf_0 = sum([res[1] for res in rec_res_0 if res])
        conf_90 = sum([res[1] for res in rec_res_90 if res])
        conf_180 = sum([res[1] for res in rec_res_180 if res])
        conf_270 = sum([res[1] for res in rec_res_270 if res])
        
        # Find the rotation that gives the maximum confidence
        confs = {
            0: conf_0,
            90: conf_90, # If rotating 90 makes it readable, it means original is rotated 270 (or -90)
            180: conf_180,
            270: conf_270
        }
        
        best_rot = max(confs, key=confs.get)
        
        # If best_rot is the angle we had to ROTATE it by to make it readable, 
        # then the page's current detected orientation is (360 - best_rot) % 360.
        detected_angle = (360 - best_rot) % 360
        
        print(f"--> Page {page_num} confs: 0={conf_0:.1f}, 90={conf_90:.1f}, 180={conf_180:.1f}, 270={conf_270:.1f} -> {detected_angle} deg", flush=True)
        
        return page_num, detected_angle, "universal_recognizer"
            
    except Exception as e:
        logger.error(f"Error processing page {page_num}: {e}")  
        return page_num, 0, "error"

def run_rotation_pipeline(input_folder, output_folder, use_gpu=True, gpu_mem=1500, num_workers=1, progress_callback=None):
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
    total_pages_processed = 0
    
    logger.info("Phase 1: Detecting visual orientations in parallel...")
    with ProcessPoolExecutor(max_workers=num_workers, initializer=init_worker, initargs=(use_gpu, gpu_mem)) as executor:
        for file_idx, input_pdf in enumerate(pdf_files):
            rel_path = os.path.relpath(input_pdf, input_folder)
            output_pdf = os.path.join(output_folder, rel_path)
            os.makedirs(os.path.dirname(output_pdf), exist_ok=True)
            
            logger.info(f"Processing: {input_pdf}")
            try:
                doc = fitz.open(input_pdf)
                total_pages = doc.page_count
                doc.close()
            except Exception as e:
                logger.error(f"Failed to open {input_pdf}: {e}")
                continue
                
            total_pages_processed += total_pages
            page_rotations = {}
            
            futures = {executor.submit(analyze_page_rotation, input_pdf, p): p for p in range(total_pages)}
            for future in as_completed(futures):
                try:
                    page_num, angle, method = future.result()
                    page_rotations[page_num] = (angle, method)
                except Exception as e:
                    logger.error(f"A worker failed on {input_pdf}: {e}")

            logger.info(f"Applying corrections and saving to {output_pdf}...")
            doc = fitz.open(input_pdf)
            summary = Counter()
            
            for page_num in range(total_pages):
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
                        
            doc.save(output_pdf)
            doc.close()
            
            for k, v in summary.items():
                logger.info(f"  {k}: {v} pages")
                
            if progress_callback:
                progress_callback(file_idx + 1, len(pdf_files), os.path.basename(input_pdf))
    
    overall_end_time = time.time()
    total_time = overall_end_time - overall_start_time
    logger.info("======= FINAL ROTATION SUMMARY ==========")
    logger.info(f"Total PDFs processed: {len(pdf_files)}")
    logger.info(f"Total Pages processed: {total_pages_processed}")
    logger.info(f"Total processing time: {total_time:.2f} seconds")
    logger.info("=========================================")
    
    return {
        "status": "completed",
        "files_processed": len(pdf_files),
        "pages_processed": total_pages_processed,
        "time_seconds": total_time
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
