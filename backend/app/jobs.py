"""
Incremental, fair OCR job scheduling.

A job is a batch of PDFs the user sees as one unit (one progress view, one review,
one download). Processing it is split into *slices* of a few pages each, which is
what lets:

  - a file start processing the moment its upload finishes, instead of waiting for
    every file in the batch;
  - a small job run alongside a huge one instead of queueing behind it;
  - OCR models stay loaded in long-lived worker processes (no per-job warm-up).

Fairness: each job keeps at most JOB_PARALLELISM slices in the Celery queue at once.
When a slice finishes, that job's next slice goes to the *back* of the queue, so
active jobs take turns. A 10,000-page job and a 10-page job interleave; the small one
finishes in seconds.

State lives in two places:
  - Redis (live): job metadata, per-file progress, pending slices, in-flight count,
    recent page timestamps for the ETA. Keys expire after KEY_TTL.
  - Disk (durable), in the job's session folder:
        results/pages/<file-hash>/<page>.json   one per analysed page
        results/files/<file-hash>.json          per-file summary once the PDF is saved
    Reviews and downloads read results from disk, so they don't expire with Celery's
    24 h result TTL, and a worker crash loses at most the page in progress.

Both the API (adds files, seals, reads snapshots) and the worker (processes slices)
import this module. It must stay free of ML imports.
"""
import hashlib
import json
import os
import time
import uuid
from typing import Callable, Dict, List, Optional

import redis

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
# Pages per task. Smaller slices let a newly submitted job start sooner (it waits at most
# one in-flight slice, ~1 s/page on an RTX 3050) at the cost of a little dispatch overhead.
SLICE_PAGES = max(1, int(os.getenv("OCR_SLICE_PAGES", "4")))
# Slices of one job allowed in the queue at once. Match it to worker concurrency so a
# job running alone still uses every OCR process.
JOB_PARALLELISM = max(1, int(os.getenv("OCR_JOB_PARALLELISM", "2")))
# An upload nobody finished (tab closed) gets sealed with whatever arrived.
STALE_UPLOAD_SECONDS = int(os.getenv("STALE_UPLOAD_SECONDS", str(30 * 60)))
KEY_TTL = 7 * 24 * 3600
RATE_WINDOW = 30

PROCESS_PAGES_TASK = "process_pages"
OCR_QUEUE = "ocr"

_client: Optional[redis.Redis] = None


def client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    return _client


def _k(job_id: str, part: str) -> str:
    return f"job:{job_id}:{part}"


_PARTS = ("meta", "files", "done", "fstatus", "pending", "inflight", "recent", "completed")


def _touch(job_id: str, pipe=None) -> None:
    p = pipe or client().pipeline()
    p.hset(_k(job_id, "meta"), "updated", time.time())
    for part in _PARTS:
        p.expire(_k(job_id, part), KEY_TTL)
    if pipe is None:
        p.execute()


# ----- disk layout -----

def _file_key(filename: str) -> str:
    return hashlib.sha1(filename.encode("utf-8")).hexdigest()[:20]


def page_result_path(session_dir: str, filename: str, page: int) -> str:
    return os.path.join(session_dir, "results", "pages", _file_key(filename), f"{page}.json")


def file_result_path(session_dir: str, filename: str) -> str:
    return os.path.join(session_dir, "results", "files", f"{_file_key(filename)}.json")


def write_json_atomic(path: str, data) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def has_disk_results(session_dir: str) -> bool:
    return os.path.isdir(os.path.join(session_dir, "results", "files"))


def load_results(session_dir: str) -> Dict:
    """All finished files, in the shape the review/download endpoints already use."""
    rotations: Dict[str, Dict[str, int]] = {}
    details: Dict[str, Dict[str, Dict]] = {}
    folder = os.path.join(session_dir, "results", "files")
    if os.path.isdir(folder):
        for entry in sorted(os.listdir(folder)):
            if not entry.endswith(".json"):
                continue
            try:
                with open(os.path.join(folder, entry), encoding="utf-8") as fh:
                    summary = json.load(fh)
            except (OSError, ValueError):
                continue
            rotations[summary["filename"]] = summary["page_rotations"]
            details[summary["filename"]] = summary["page_details"]
    return {
        "status": "completed",
        "output_folder": os.path.join(session_dir, "output"),
        "files_processed": len(rotations),
        "pages_processed": sum(len(r) for r in rotations.values()),
        "page_rotations": rotations,
        "page_details": details,
    }


# ----- scheduling -----

# Atomically: if the job may have another slice in flight, move one from pending to
# in-flight. Doing check-and-increment in one step is what prevents two finishing
# slices from both deciding there's room and overshooting the job's share.
_PUMP_LUA = """
if redis.call('HGET', KEYS[3], 'cancelled') == '1' then return nil end
local inflight = tonumber(redis.call('GET', KEYS[1]) or '0')
if inflight >= tonumber(ARGV[1]) then return nil end
local s = redis.call('LPOP', KEYS[2])
if not s then return nil end
redis.call('INCR', KEYS[1])
return s
"""
_pump_script = None


def pump(job_id: str, celery_app) -> int:
    """Queue as many of this job's pending slices as its fair share allows."""
    global _pump_script
    r = client()
    if _pump_script is None:
        _pump_script = r.register_script(_PUMP_LUA)
    sent = 0
    while True:
        raw = _pump_script(keys=[_k(job_id, "inflight"), _k(job_id, "pending"), _k(job_id, "meta")],
                           args=[JOB_PARALLELISM], client=r)
        if raw is None:
            return sent
        sl = json.loads(raw)
        try:
            celery_app.send_task(PROCESS_PAGES_TASK, args=[job_id, sl["filename"], sl["start"], sl["end"]],
                                 queue=OCR_QUEUE)
            sent += 1
        except Exception:
            # Couldn't reach the broker: put the slice back so nothing is lost.
            r.lpush(_k(job_id, "pending"), raw)
            r.decr(_k(job_id, "inflight"))
            raise


def create_job(job_id: str, user_id: int, session_id: str, use_gpu: bool) -> None:
    r = client()
    now = time.time()
    p = r.pipeline()
    p.hset(_k(job_id, "meta"), mapping={
        "user_id": user_id, "session_id": session_id, "use_gpu": int(use_gpu),
        "sealed": 0, "cancelled": 0, "status": "PROCESSING",
        "created": now, "updated": now,
    })
    p.set(_k(job_id, "inflight"), 0)
    _touch(job_id, p)
    p.execute()


def meta(job_id: str) -> Dict[str, str]:
    return client().hgetall(_k(job_id, "meta"))


def add_file(job_id: str, filename: str, pages: int, celery_app) -> bool:
    """
    Schedules a file for processing. Idempotent: a retried call for the same file is a
    no-op, so the upload path can call it freely. Returns True if newly added.
    """
    r = client()
    if not r.hsetnx(_k(job_id, "files"), filename, pages):
        return False
    p = r.pipeline()
    p.hset(_k(job_id, "fstatus"), filename, "queued")
    for start in range(0, pages, SLICE_PAGES):
        p.rpush(_k(job_id, "pending"),
                json.dumps({"filename": filename, "start": start, "end": min(start + SLICE_PAGES, pages)}))
    _touch(job_id, p)
    p.execute()
    publish_progress(job_id)
    pump(job_id, celery_app)
    return True


def seal(job_id: str) -> None:
    """No more files are coming. The job completes once the files it has are done."""
    r = client()
    r.hset(_k(job_id, "meta"), "sealed", 1)
    _touch(job_id)
    check_complete(job_id)


def cancel(job_id: str) -> None:
    r = client()
    p = r.pipeline()
    p.hset(_k(job_id, "meta"), mapping={"cancelled": 1, "status": "CANCELLED"})
    p.delete(_k(job_id, "pending"))
    p.execute()


def slice_finished(job_id: str, celery_app) -> None:
    r = client()
    if r.decr(_k(job_id, "inflight")) < 0:
        r.set(_k(job_id, "inflight"), 0)
    pump(job_id, celery_app)


def page_done(job_id: str) -> None:
    r = client()
    p = r.pipeline()
    p.rpush(_k(job_id, "recent"), time.time())
    p.ltrim(_k(job_id, "recent"), -RATE_WINDOW, -1)
    p.execute()


# A file's status only moves forward: once "done" or "failed", a late progress update
# from a concurrently finishing slice must not flip it back to "processing" (the job
# would then never complete).
_STATUS_LUA = """
local current = redis.call('HGET', KEYS[1], ARGV[1])
if (current == 'done' or current == 'failed') and ARGV[2] ~= 'done' and ARGV[2] ~= 'failed' then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 1
"""
_status_script = None


def file_progress(job_id: str, filename: str, done_pages: int, status: str = "processing") -> None:
    global _status_script
    r = client()
    if _status_script is None:
        _status_script = r.register_script(_STATUS_LUA)
    p = r.pipeline()
    p.hset(_k(job_id, "done"), filename, done_pages)
    _touch(job_id, p)
    p.execute()
    _status_script(keys=[_k(job_id, "fstatus")], args=[filename, status], client=r)


def file_status(job_id: str, filename: str) -> Optional[str]:
    return client().hget(_k(job_id, "fstatus"), filename)


def check_complete(job_id: str) -> bool:
    """Marks the job finished (once) when it's sealed and every file has settled."""
    r = client()
    m = meta(job_id)
    if not m or m.get("sealed") != "1" or m.get("cancelled") == "1" or m.get("status") != "PROCESSING":
        return False
    statuses = r.hgetall(_k(job_id, "fstatus"))
    if not statuses:
        outcome, error = "FAILED", "No files were uploaded."
    elif any(s not in ("done", "failed") for s in statuses.values()):
        return False
    elif all(s == "failed" for s in statuses.values()):
        outcome, error = "FAILED", "None of the files could be processed."
    else:
        outcome, error = "SUCCESS", None

    # Several slices can finish at the same moment; only one may announce completion.
    if not r.set(_k(job_id, "completed"), 1, nx=True, ex=KEY_TTL):
        return True
    fields = {"status": outcome, "completed_at": time.time()}
    if error:
        fields["error"] = error
    r.hset(_k(job_id, "meta"), mapping=fields)
    publish(job_id, {"task_id": job_id, "status": outcome, **({"error": error} if error else {})})
    return True


def autoseal_if_stale(job_id: str) -> None:
    m = meta(job_id)
    if m and m.get("sealed") != "1" and m.get("cancelled") != "1":
        if time.time() - float(m.get("updated", 0)) > STALE_UPLOAD_SECONDS:
            seal(job_id)


# ----- progress -----

def snapshot(job_id: str) -> Optional[Dict]:
    """Current progress in the message format the web UI consumes."""
    r = client()
    p = r.pipeline()
    p.hgetall(_k(job_id, "meta"))
    p.hgetall(_k(job_id, "files"))
    p.hgetall(_k(job_id, "done"))
    p.hgetall(_k(job_id, "fstatus"))
    p.lrange(_k(job_id, "recent"), 0, -1)
    m, files, done, fstatus, recent = p.execute()
    if not m:
        return None

    total_pages = sum(int(v) for v in files.values())
    completed_pages = 0
    files_status = {}
    for name, pages in files.items():
        pages = int(pages)
        status = fstatus.get(name, "queued")
        d = pages if status == "done" else min(int(done.get(name, 0)), pages)
        completed_pages += d
        if status in ("done", "failed"):
            files_status[name] = status
        elif d > 0:
            files_status[name] = f"processing ({d}/{pages})"
        else:
            files_status[name] = "queued"

    rate = 0.0
    stamps = [float(t) for t in recent]
    if len(stamps) >= 2 and stamps[-1] > stamps[0]:
        rate = (len(stamps) - 1) / (stamps[-1] - stamps[0])
    remaining = total_pages - completed_pages
    created = float(m.get("created", time.time()))

    return {
        "task_id": job_id,
        "status": m.get("status", "PROCESSING"),
        "sealed": m.get("sealed") == "1",
        "error": m.get("error"),
        "completed_files": sum(1 for s in files_status.values() if s in ("done", "failed")),
        "total_files": len(files),
        "files_status": files_status,
        "completed_pages": completed_pages,
        "total_pages": total_pages,
        "elapsed_seconds": round(time.time() - created, 1),
        "pages_per_second": round(rate, 3),
        "eta_seconds": round(remaining / rate) if rate > 0 and remaining > 0 else (0 if total_pages and remaining == 0 else None),
    }


def publish(job_id: str, message: Dict) -> None:
    client().publish(f"task_progress_{job_id}", json.dumps(message))


def publish_progress(job_id: str) -> None:
    snap = snapshot(job_id)
    if snap and snap["status"] == "PROCESSING":
        publish(job_id, snap)


# ----- worker-side processing -----

def process_slice(
    job_id: str,
    filename: str,
    start: int,
    end: int,
    tmp_dir: str,
    analyze: Callable,
    save_pdf: Callable,
) -> None:
    """
    Analyse pages [start, end) of one file, then finalize the file if this completed it.
    `analyze` and `save_pdf` are injected so this module stays free of ML imports.
    Safe to re-run (redelivery after a worker crash): pages already on disk are skipped.
    """
    m = meta(job_id)
    if not m or m.get("cancelled") == "1":
        return
    session_dir = os.path.join(tmp_dir, m["session_id"])
    pdf_path = os.path.join(session_dir, "input", filename)
    pages = int(client().hget(_k(job_id, "files"), filename) or 0)
    if not os.path.exists(pdf_path) or pages <= 0:
        file_progress(job_id, filename, 0, "failed")
        check_complete(job_id)
        return

    for page in range(start, end):
        out = page_result_path(session_dir, filename, page)
        if os.path.exists(out):
            continue
        _page, angle, method, details, text_layer = analyze(pdf_path, page)
        write_json_atomic(out, {"angle": angle, "method": method, "details": details, "text": text_layer})
        page_done(job_id)
        pages_dir = os.path.dirname(out)
        done = sum(1 for n in os.listdir(pages_dir) if n.endswith(".json"))
        file_progress(job_id, filename, done)
        publish_progress(job_id)

    finalize_file(job_id, session_dir, filename, pages, pdf_path, save_pdf)


def finalize_file(job_id: str, session_dir: str, filename: str, pages: int, pdf_path: str,
                  save_pdf: Callable) -> None:
    summary_path = file_result_path(session_dir, filename)
    if os.path.exists(summary_path):
        # Already saved by another slice (or a redelivered task): make sure the status says so.
        file_progress(job_id, filename, pages, "done")
        check_complete(job_id)
        return
    pages_dir = os.path.dirname(page_result_path(session_dir, filename, 0))
    if not all(os.path.exists(os.path.join(pages_dir, f"{p}.json")) for p in range(pages)):
        return  # other slices of this file are still running

    # Slices of the same file can complete together; exactly one saves the PDF.
    lock = summary_path + ".lock"
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    try:
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        return

    try:
        rotations, text, rotation_map, detail_map = {}, {}, {}, {}
        for p in range(pages):
            with open(os.path.join(pages_dir, f"{p}.json"), encoding="utf-8") as fh:
                rec = json.load(fh)
            rotations[p] = (rec["angle"], rec["method"])
            text[p] = rec["text"]
            rotation_map[str(p)] = rec["angle"]
            detail_map[str(p)] = {**rec["details"], "angle": rec["angle"], "method": rec["method"]}

        output_pdf = os.path.join(session_dir, "output", filename)
        save_pdf(pdf_path, output_pdf, rotations, text)
        if not os.path.exists(output_pdf):
            raise RuntimeError("output PDF was not written")

        write_json_atomic(summary_path, {"filename": filename, "page_rotations": rotation_map,
                                         "page_details": detail_map})
        file_progress(job_id, filename, pages, "done")
    except Exception as exc:  # noqa: BLE001 - recorded as a failed file, never crashes the worker
        client().hset(_k(job_id, "meta"), "last_error", f"{filename}: {exc}")
        file_progress(job_id, filename, pages, "failed")
    finally:
        if os.path.exists(lock):
            os.remove(lock)

    publish_progress(job_id)
    check_complete(job_id)
