import os
import sys

# Ensure the current directory is in the Python path for Celery workers
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from celery import Celery
from celery.schedules import crontab
import time
import shutil
import json
import redis

# Configure Celery to use Redis as the message broker and backend
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

app = Celery("pdf_worker", broker=REDIS_URL, backend=REDIS_URL)

app.conf.beat_schedule = {
    'cleanup-old-tmp-files-hourly': {
        'task': 'cleanup_old_files',
        'schedule': crontab(minute=0), # Every hour
    },
}

redis_client = redis.Redis.from_url(REDIS_URL)

@app.task(bind=True, name="process_pdf_rotation")
def process_pdf_rotation(self, input_folder: str, output_folder: str, use_gpu: bool, gpu_mem: int, num_workers: int):
    """
    Celery task that triggers the PDF rotation pipeline.
    """
    # Import inside the task so the lightweight API container doesn't try to load heavy ML libraries like cv2
    from scalable_pdf_rotation import run_rotation_pipeline

    # Mark state as processing
    self.update_state(state='PROCESSING', meta={'status': 'Starting rotation pipeline...', 'completed_files': 0, 'total_files': 0})
    
    def progress_callback(completed, total, filename, files_status, stats=None):
        stats = stats or {}
        # Update celery state
        meta = {'status': f'Processing {filename}...', 'completed_files': completed, 'total_files': total}
        meta.update(stats)
        self.update_state(state='PROCESSING', meta=meta)
        # Publish real-time to redis for websockets
        message = json.dumps({
            "task_id": self.request.id,
            "status": "PROCESSING",
            "completed_files": completed,
            "total_files": total,
            "filename": filename,
            "files_status": files_status,
            # Measured throughput - lets the UI show a real ETA instead of a guess
            **stats
        })
        redis_client.publish(f"task_progress_{self.request.id}", message)

    try:
        # Call the core pipeline
        result = run_rotation_pipeline(
            input_folder=input_folder,
            output_folder=output_folder,
            use_gpu=use_gpu,
            gpu_mem=gpu_mem,
            num_workers=num_workers,
            progress_callback=progress_callback
        )
        
        if result.get("status") == "failed":
            self.update_state(state='FAILED', meta={'error': result.get("error")})
            raise Exception(result.get("error"))
            
        result["output_folder"] = output_folder
        
        # Publish completion
        message = json.dumps({
            "task_id": self.request.id,
            "status": "SUCCESS"
        })
        redis_client.publish(f"task_progress_{self.request.id}", message)
        
        return result

    except Exception as e:
        self.update_state(state='FAILED', meta={'error': str(e)})
        
        # Publish error
        message = json.dumps({
            "task_id": self.request.id,
            "status": "FAILED",
            "error": str(e)
        })
        redis_client.publish(f"task_progress_{self.request.id}", message)
        
        raise e

@app.task(name="cleanup_old_files")
def cleanup_old_files():
    """
    Deletes folders in /app/tmp that are older than 24 hours.
    """
    tmp_dir = "/app/tmp"
    if not os.path.exists(tmp_dir):
        return
        
    now = time.time()
    cutoff = now - (24 * 60 * 60) # 24 hours
    
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
