"""
The Celery application, separate from the task definitions.

The API only needs to *send* tasks and read state. Keeping the app object here means
the API and app.jobs can dispatch by task name without importing app.worker, whose
signal handlers load OCR models.
"""
import os

from celery import Celery
from celery.schedules import crontab

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

OCR_QUEUE = "ocr"

app = Celery("pdf_worker", broker=REDIS_URL, backend=REDIS_URL)

app.conf.update(
    # One task at a time per process: a slice of pages is a few seconds of GPU work,
    # and prefetching more would let a process hoard slices from other jobs.
    worker_prefetch_multiplier=1,
    task_default_queue="celery",
    beat_schedule={
        "cleanup-old-tmp-files-hourly": {
            "task": "cleanup_old_files",
            "schedule": crontab(minute=0),
        },
    },
)
