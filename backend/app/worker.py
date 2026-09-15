import os
import sys

# Put backend/ (the parent of the `app` package) on the path so Celery can import
# `app.*` regardless of working directory.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json  # noqa: E402
import logging  # noqa: E402
import shutil  # noqa: E402
import time  # noqa: E402

from celery.signals import celeryd_init, worker_process_init  # noqa: E402

from app import jobs  # noqa: E402
from app.celery_app import REDIS_URL, app  # noqa: E402,F401  (REDIS_URL re-exported for callers)

logger = logging.getLogger(__name__)

TMP_DIR = os.getenv("TMP_DIR", "/app/tmp")
# VRAM each OCR process reserves. Concurrency is derived from it (see below).
GPU_MEM_MB = int(os.getenv("OCR_GPU_MEM_MB", "1500"))

# ---------------------------------------------------------------------------
# Worker process model
#
# Each Celery pool process loads PaddleOCR once, when it starts, and keeps it for its
# whole life. Tasks are small (a slice of a few pages), so jobs interleave fairly and
# nothing pays a model load per job. This replaces the previous design, where every
# job spawned its own multiprocessing.Pool, loaded the models again (~7 s), and had to
# tear the pool down afterwards - the source of the CUDA teardown hangs.
#
# The parent process must never initialise CUDA: pool processes are forked from it.
# Models are loaded in worker_process_init, which runs in each child after the fork.
# ---------------------------------------------------------------------------


@celeryd_init.connect
def _set_concurrency(conf=None, **_kwargs):
    """One OCR process per GPU memory slot, unless OCR_CONCURRENCY says otherwise."""
    explicit = os.getenv("OCR_CONCURRENCY")
    if explicit:
        conf.worker_concurrency = max(1, int(explicit))
        return
    from app.pipeline.rotation import _cap_gpu_workers, _get_gpu_memory_mb

    if _get_gpu_memory_mb():
        conf.worker_concurrency = max(1, _cap_gpu_workers(8, GPU_MEM_MB))
    else:
        conf.worker_concurrency = 2
    logger.info(f"OCR worker concurrency: {conf.worker_concurrency}")


@worker_process_init.connect
def _load_ocr_model(**_kwargs):
    from app.pipeline import rotation

    use_gpu = rotation._get_gpu_memory_mb() is not None
    rotation.init_worker(use_gpu=use_gpu, gpu_mem=GPU_MEM_MB)


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


@app.task(name=jobs.PROCESS_PAGES_TASK, acks_late=True, reject_on_worker_lost=True)
def process_pages(job_id: str, filename: str, start: int, end: int):
    """
    OCR one slice of one file. acks_late + reject_on_worker_lost: if the process dies
    mid-slice the slice is redelivered, and pages already saved to disk are skipped.
    """
    from app.pipeline import rotation

    try:
        jobs.process_slice(
            job_id, filename, start, end, TMP_DIR,
            analyze=rotation.analyze_page_rotation,
            save_pdf=rotation._save_completed_pdf,
        )
    finally:
        # Always release this job's slot and queue its next slice, even on failure,
        # or the job would stall with work still pending.
        jobs.slice_finished(job_id, app)


@app.task(bind=True, name="process_pdf_rotation")
def process_pdf_rotation(self, input_folder: str, output_folder: str, use_gpu: bool = True,
                         gpu_mem: int = 1500, num_workers: int = 1):
    """
    Legacy whole-folder task, kept for POST /api/v1/rotate. Runs sequentially in this
    already-initialised process instead of spawning a pool of model processes, which
    would exhaust VRAM next to the persistent OCR workers. `use_gpu`, `gpu_mem` and
    `num_workers` are accepted for compatibility; the worker's own setup decides them.
    """
    from app.pipeline import rotation

    task_id = self.request.id
    channel = f"task_progress_{task_id}"

    def publish(message):
        jobs.client().publish(channel, json.dumps({"task_id": task_id, **message}))

    try:
        pdf_files = []
        for root, _dirs, files in os.walk(input_folder):
            pdf_files.extend(os.path.join(root, f) for f in files if f.lower().endswith(".pdf"))
        if not pdf_files:
            raise ValueError(f"No PDFs found in {input_folder}")

        import fitz

        counts = {}
        for path in pdf_files:
            with fitz.open(path) as doc:
                counts[path] = doc.page_count
        total_pages = sum(counts.values())

        started = time.time()
        completed_pages = 0
        files_status = {os.path.basename(p): "queued" for p in pdf_files}
        page_rotations, page_details = {}, {}

        for index, path in enumerate(pdf_files):
            name = os.path.basename(path)
            rotations, text, details = {}, {}, {}
            for page in range(counts[path]):
                _p, angle, method, detail, lines = rotation.analyze_page_rotation(path, page)
                rotations[page] = (angle, method)
                text[page] = lines
                details[page] = {**detail, "angle": angle, "method": method}
                completed_pages += 1
                files_status[name] = f"processing ({page + 1}/{counts[path]})"
                elapsed = time.time() - started
                rate = completed_pages / elapsed if elapsed > 0 else 0
                stats = {
                    "completed_files": index, "total_files": len(pdf_files), "filename": name,
                    "files_status": files_status, "completed_pages": completed_pages,
                    "total_pages": total_pages, "elapsed_seconds": round(elapsed, 1),
                    "pages_per_second": round(rate, 3),
                    "eta_seconds": round((total_pages - completed_pages) / rate) if rate else None,
                }
                self.update_state(state="PROCESSING", meta=stats)
                publish({"status": "PROCESSING", **stats})

            out = os.path.join(output_folder, os.path.relpath(path, input_folder))
            rotation._save_completed_pdf(path, out, rotations, text)
            page_rotations[name] = {p: r[0] for p, r in rotations.items()}
            page_details[name] = details
            files_status[name] = "done"

        publish({"status": "SUCCESS"})
        return {
            "status": "completed",
            "files_processed": len(pdf_files),
            "pages_processed": total_pages,
            "time_seconds": time.time() - started,
            "page_rotations": page_rotations,
            "page_details": page_details,
            "output_folder": output_folder,
        }
    except Exception as exc:
        publish({"status": "FAILED", "error": str(exc)})
        raise


@app.task(name="cleanup_old_files")
def cleanup_old_files():
    """
    Deletes folders in the shared tmp dir that are older than 24 hours.
    """
    tmp_dir = TMP_DIR
    if not os.path.exists(tmp_dir):
        return

    now = time.time()
    cutoff = now - (24 * 60 * 60)  # 24 hours

    deleted_count = 0
    for folder in os.listdir(tmp_dir):
        # Ignore files, only look at session directories
        folder_path = os.path.join(tmp_dir, folder)
        if os.path.isdir(folder_path):
            stat = os.stat(folder_path)
            if stat.st_mtime < cutoff:
                try:
                    shutil.rmtree(folder_path)
                    deleted_count += 1
                except Exception as e:
                    print(f"Failed to delete {folder_path}: {e}")

    # Also delete old zip files
    for file in os.listdir(tmp_dir):
        if file.endswith('.zip'):
            file_path = os.path.join(tmp_dir, file)
            stat = os.stat(file_path)
            if stat.st_mtime < cutoff:
                try:
                    os.remove(file_path)
                    deleted_count += 1
                except Exception as e:
                    print(f"Failed to delete {file_path}: {e}")

    print(f"Cleanup finished. Deleted {deleted_count} items.")
    return f"Deleted {deleted_count} items."
