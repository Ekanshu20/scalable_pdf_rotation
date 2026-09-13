"""
Resumable, chunked uploads.

Why: a batch of scanned PDFs sent as one HTTP request fails as a whole on any
network hiccup, exceeds proxy body limits (Cloudflare: 100 MB per request), and
gives the user no progress. Instead the client uploads each file in small
chunks, each chunk its own request, and can resume from the byte offset the
server reports after a failure.

Protocol (all under /api/v1/uploads, see main.py):
    POST   /                         -> create an upload session
    POST   /{upload_id}/files        -> register a file (name + size)
    PUT    /{upload_id}/files/{fid}  -> append one chunk at ?offset=N (raw body)
    GET    /{upload_id}/files/{fid}  -> how many bytes the server has (resume)
    POST   /{upload_id}/commit       -> queue processing for the completed files
    DELETE /{upload_id}              -> discard

Storage, inside the job's normal session folder so the worker and the hourly
cleanup need no changes:
    {tmp}/{upload_id}/input/<name>.pdf      completed files (what the worker reads)
    {tmp}/{upload_id}/output/               worker output
    {tmp}/{upload_id}/.upload/session.json  owner, written once
    {tmp}/{upload_id}/.upload/<fid>.json    per-file state, written by one request at a time
    {tmp}/{upload_id}/.upload/<fid>.part    bytes received so far

Per-file state files (not one shared manifest) mean parallel uploads of
different files never race on the same write. Received size is the .part
file's length on disk, so it is always the truth after a crash or retry.
"""
import gc
import hashlib
import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass
from typing import AsyncIterator, Dict, List, Optional

import fitz  # PyMuPDF

MB = 1024 * 1024

# What the client is told to use; well under Cloudflare's 100 MB request cap and
# small enough that a failed chunk costs seconds, not minutes, to resend.
CHUNK_SIZE = 8 * MB
# Hard server-side cap on a single request body.
MAX_CHUNK_BYTES = 16 * MB
MAX_FILE_BYTES = int(os.getenv("MAX_UPLOAD_FILE_MB", "2048")) * MB
MAX_FILES_PER_UPLOAD = int(os.getenv("MAX_UPLOAD_FILES", "1000"))

_META = ".upload"
# A chunk is at most 16 MB; a lock older than this belongs to a dead request.
LOCK_STALE_SECONDS = 300


class UploadError(Exception):
    def __init__(self, status: int, detail: str, **extra):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.extra = extra


@dataclass
class FileState:
    file_id: str
    filename: str
    size: int
    received: int
    complete: bool
    pages: Optional[int] = None

    def public(self) -> Dict:
        return {
            "file_id": self.file_id,
            "filename": self.filename,
            "size": self.size,
            "received": self.received,
            "complete": self.complete,
            "pages": self.pages,
        }


def _atomic_write_json(path: str, data: Dict) -> None:
    tmp = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


def _read_json(path: str) -> Dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class UploadStore:
    def __init__(self, tmp_dir: str):
        self.tmp_dir = tmp_dir

    # ----- paths -----

    def _session_dir(self, upload_id: str) -> str:
        # Parsing as a UUID is also the path-traversal guard.
        try:
            canonical = str(uuid.UUID(upload_id))
        except (ValueError, AttributeError, TypeError):
            raise UploadError(404, "Upload not found")
        return os.path.join(self.tmp_dir, canonical)

    def _meta_dir(self, upload_id: str) -> str:
        return os.path.join(self._session_dir(upload_id), _META)

    def input_dir(self, upload_id: str) -> str:
        return os.path.join(self._session_dir(upload_id), "input")

    def output_dir(self, upload_id: str) -> str:
        return os.path.join(self._session_dir(upload_id), "output")

    # ----- session -----

    def create(self, user_id: int) -> str:
        upload_id = str(uuid.uuid4())
        os.makedirs(self.input_dir(upload_id))
        os.makedirs(self.output_dir(upload_id))
        os.makedirs(self._meta_dir(upload_id))
        _atomic_write_json(
            os.path.join(self._meta_dir(upload_id), "session.json"),
            {"user_id": user_id, "created_at": time.time()},
        )
        return upload_id

    def _require_session(self, upload_id: str, user_id: int, allow_committed: bool = False) -> str:
        meta = self._meta_dir(upload_id)
        try:
            session = _read_json(os.path.join(meta, "session.json"))
        except (FileNotFoundError, json.JSONDecodeError):
            raise UploadError(404, "Upload not found")
        if session.get("user_id") != user_id:
            # Same response as missing: don't reveal other users' upload ids.
            raise UploadError(404, "Upload not found")
        if not allow_committed and os.path.exists(os.path.join(meta, "committed")):
            raise UploadError(409, "This upload has already been submitted")
        return meta

    def discard(self, upload_id: str, user_id: int) -> None:
        self._require_session(upload_id, user_id)
        shutil.rmtree(self._session_dir(upload_id), ignore_errors=True)

    # ----- files -----

    def register_file(self, upload_id: str, user_id: int, filename: str, size: int) -> FileState:
        meta = self._require_session(upload_id, user_id)

        name = os.path.basename((filename or "").replace("\\", "/")).strip()
        if not name or name in {".", ".."} or not name.lower().endswith(".pdf"):
            raise UploadError(400, "Only .pdf files can be uploaded")
        if size <= 0:
            raise UploadError(400, f"{name} is empty")
        if size > MAX_FILE_BYTES:
            raise UploadError(413, f"{name} is larger than the {MAX_FILE_BYTES // MB} MB limit")

        # The claim file maps a filename to its file_id and is created with
        # O_EXCL, so two registrations of the same name can't both succeed.
        claim = os.path.join(meta, "name-" + hashlib.sha256(name.encode("utf-8")).hexdigest()[:32])
        file_id = uuid.uuid4().hex
        try:
            fd = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            existing = self._load_file(meta, open(claim, encoding="utf-8").read().strip(), upload_id)
            if existing.size == size:
                # A retried registration (the response was lost): hand back the
                # same file so the client resumes instead of starting over.
                return existing
            raise UploadError(409, f"Another file named {name} is already in this upload")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(file_id)

        count = sum(1 for n in os.listdir(meta) if n.startswith("name-"))
        if count > MAX_FILES_PER_UPLOAD:
            os.remove(claim)
            raise UploadError(413, f"An upload can contain at most {MAX_FILES_PER_UPLOAD} files")

        _atomic_write_json(
            os.path.join(meta, f"{file_id}.json"),
            {"filename": name, "size": size, "complete": False, "pages": None},
        )
        open(os.path.join(meta, f"{file_id}.part"), "wb").close()
        return FileState(file_id, name, size, 0, False)

    def _load_file(self, meta: str, file_id: str, upload_id: str) -> FileState:
        if not file_id.isalnum():
            raise UploadError(404, "File not found in this upload")
        try:
            data = _read_json(os.path.join(meta, f"{file_id}.json"))
        except (FileNotFoundError, json.JSONDecodeError):
            raise UploadError(404, "File not found in this upload")
        if data.get("invalid"):
            raise UploadError(422, f"{data['filename']} is not a readable PDF", received=0, invalid=True)
        if data["complete"]:
            received = data["size"]
        else:
            part = os.path.join(meta, f"{file_id}.part")
            received = os.path.getsize(part) if os.path.exists(part) else 0
        return FileState(file_id, data["filename"], data["size"], received, data["complete"], data.get("pages"))

    def file_status(self, upload_id: str, user_id: int, file_id: str) -> FileState:
        meta = self._require_session(upload_id, user_id)
        return self._load_file(meta, file_id, upload_id)

    async def write_chunk(
        self,
        upload_id: str,
        user_id: int,
        file_id: str,
        offset: int,
        body: AsyncIterator[bytes],
        content_length: Optional[int],
    ) -> FileState:
        meta = self._require_session(upload_id, user_id)
        state = self._load_file(meta, file_id, upload_id)

        if state.complete:
            if offset >= state.size:
                return state  # retry of the final chunk whose response was lost
            raise UploadError(409, "File already complete", received=state.size)
        if offset != state.received:
            # Client and server disagree (a chunk was lost or duplicated): tell
            # the client where to resume from rather than corrupting the file.
            raise UploadError(409, "Offset mismatch", received=state.received)
        if content_length is not None and content_length > MAX_CHUNK_BYTES:
            raise UploadError(413, f"Chunks are limited to {MAX_CHUNK_BYTES // MB} MB")

        # One writer per file. A client that timed out and retried while its
        # first request is still streaming would otherwise interleave bytes.
        lock = os.path.join(meta, f"{file_id}.lock")
        try:
            os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            if time.time() - os.path.getmtime(lock) < LOCK_STALE_SECONDS:
                raise UploadError(409, "This file is already receiving a chunk", received=state.received)
            os.utime(lock)  # stale lock from a crashed request: take it over
        try:
            return await self._append(upload_id, meta, file_id, state, offset, body)
        finally:
            if os.path.exists(lock):
                os.remove(lock)

    async def _append(self, upload_id, meta, file_id, state, offset, body) -> FileState:
        part = os.path.join(meta, f"{file_id}.part")
        written = 0
        limit = min(MAX_CHUNK_BYTES, state.size - offset)
        with open(part, "r+b") as fh:
            fh.seek(offset)
            try:
                async for piece in body:
                    written += len(piece)
                    if written > limit:
                        raise UploadError(413, "Chunk exceeds the declared file size or chunk limit")
                    fh.write(piece)
            except UploadError:
                fh.truncate(offset)
                raise
            except Exception:
                # Client disconnected mid-chunk: drop the partial chunk so the
                # next attempt resumes from a clean boundary.
                fh.truncate(offset)
                raise UploadError(400, "Upload interrupted", received=offset)
            fh.truncate(offset + written)

        received = offset + written
        if received < state.size:
            return FileState(file_id, state.filename, state.size, received, False)

        return self._finalize(upload_id, meta, file_id, state)

    def _finalize(self, upload_id: str, meta: str, file_id: str, state: FileState) -> FileState:
        part = os.path.join(meta, f"{file_id}.part")
        target = os.path.join(self.input_dir(upload_id), state.filename)
        try:
            with fitz.open(part, filetype="pdf") as doc:
                pages = doc.page_count
            if pages <= 0:
                raise ValueError("no pages")
        except Exception:
            # PyMuPDF can keep the handle of a file it failed to parse open until
            # it's garbage-collected; Windows then refuses the delete. Record the
            # verdict first so the outcome never depends on the cleanup.
            _atomic_write_json(
                os.path.join(meta, f"{file_id}.json"),
                {"filename": state.filename, "size": state.size, "complete": False, "pages": None, "invalid": True},
            )
            gc.collect()
            try:
                os.remove(part)
            except OSError:
                pass
            raise UploadError(422, f"{state.filename} is not a readable PDF", received=0, invalid=True)

        os.replace(part, target)
        _atomic_write_json(
            os.path.join(meta, f"{file_id}.json"),
            {"filename": state.filename, "size": state.size, "complete": True, "pages": pages},
        )
        return FileState(file_id, state.filename, state.size, state.size, True, pages)

    # ----- commit -----

    def committed_result(self, upload_id: str, user_id: int) -> Optional[Dict]:
        """
        The stored response of a finished commit, if any. Makes commit idempotent:
        if the response was lost in transit, the client's retry gets the same job
        back instead of an error (and no second job is queued).
        """
        meta = self._require_session(upload_id, user_id, allow_committed=True)
        try:
            return _read_json(os.path.join(meta, "commit.json"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def record_commit(self, upload_id: str, result: Dict) -> None:
        _atomic_write_json(os.path.join(self._meta_dir(upload_id), "commit.json"), result)

    def begin_commit(self, upload_id: str, user_id: int) -> List[FileState]:
        """
        Claims the upload for processing and returns its completed files.
        Incomplete files are dropped: the client decides whether to wait for
        them or go ahead without them. Call abort_commit() if queueing fails.
        """
        meta = self._require_session(upload_id, user_id)
        try:
            # O_EXCL makes a double-click (or a retried request) unable to queue
            # the same upload twice.
            os.close(os.open(os.path.join(meta, "committed"), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
        except FileExistsError:
            # Claimed but no stored result yet: another request is queueing it right now.
            raise UploadError(409, "This upload is already being submitted")

        files = []
        for entry in sorted(os.listdir(meta)):
            if entry.endswith(".json") and entry != "session.json":
                try:
                    state = self._load_file(meta, entry[:-5], upload_id)
                except UploadError:
                    continue  # invalid PDF: already reported to the client, not processed
                if state.complete:
                    files.append(state)
                else:
                    part = os.path.join(meta, f"{state.file_id}.part")
                    if os.path.exists(part):
                        os.remove(part)

        if not files:
            os.remove(os.path.join(meta, "committed"))
            raise UploadError(400, "No completed PDF files to process")
        return files

    def abort_commit(self, upload_id: str) -> None:
        marker = os.path.join(self._meta_dir(upload_id), "committed")
        if os.path.exists(marker):
            os.remove(marker)
