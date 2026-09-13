import { useSyncExternalStore } from 'react';
import { ApiError, api, getToken, logout } from './api';
import type { UploadFileState, UploadResult } from './types';

/**
 * Resumable chunked uploads (server protocol: backend/app/uploads.py).
 *
 * Lives outside React as a singleton store, so an upload keeps running when the
 * user switches pages; components subscribe with useUploadManager().
 *
 * Reliability model:
 *  - each file goes up in chunks, each chunk its own request (no proxy body limits)
 *  - a failed chunk is retried with backoff; before retrying, the client asks the
 *    server how many bytes it actually has, so a lost response never duplicates data
 *  - while the browser is offline, retries wait for the connection instead of
 *    burning attempts
 *  - a request that makes no progress for STALL_MS is aborted and retried
 */

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 8;
const STALL_MS = 60_000;
const SPEED_WINDOW_MS = 10_000;
const EMIT_INTERVAL_MS = 200;

export type ItemStatus = 'queued' | 'uploading' | 'retrying' | 'done' | 'failed' | 'invalid';

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  sent: number;
  status: ItemStatus;
  attempt: number;
  error?: string;
  pages?: number | null;
}

export type UploadPhase =
  | 'idle'
  | 'uploading'
  | 'attention' // some files failed after all retries; user decides
  | 'committing'
  | 'processing'
  | 'finished';

export interface UploadSnapshot {
  phase: UploadPhase;
  items: UploadItem[];
  sentBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
  taskId: string | null;
  finishedTaskId: string | null;
  error: string | null;
}

const INITIAL: UploadSnapshot = {
  phase: 'idle',
  items: [],
  sentBytes: 0,
  totalBytes: 0,
  bytesPerSecond: null,
  etaSeconds: null,
  taskId: null,
  finishedTaskId: null,
  error: null,
};

class FatalItemError extends Error {
  constructor(message: string, public invalid = false) {
    super(message);
  }
}

class Cancelled extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(t);
      reject(new Cancelled());
    }, { once: true });
  });

/**
 * Resolves once the browser reports a connection. Polls as well as listening for
 * the `online` event, which isn't delivered reliably everywhere.
 */
const waitForOnline = (signal: AbortSignal) =>
  navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          window.removeEventListener('online', done);
          window.clearInterval(poll);
        };
        const done = () => {
          cleanup();
          resolve();
        };
        const poll = window.setInterval(() => navigator.onLine && done(), 2000);
        window.addEventListener('online', done);
        signal.addEventListener('abort', () => {
          cleanup();
          reject(new Cancelled());
        }, { once: true });
      });

const isRetryable = (e: unknown) =>
  !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;

const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 30_000) * (0.75 + Math.random() * 0.5);

interface ChunkOutcome {
  status: number;
  body: unknown;
}

/** XHR rather than fetch: fetch cannot report upload progress. */
function putChunk(
  url: string,
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<ChunkOutcome> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stall = 0;
    const armStall = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => xhr.abort(), STALL_MS);
    };
    const finish = () => {
      window.clearTimeout(stall);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => xhr.abort();

    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      armStall();
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      finish();
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page, e.g. from a proxy */
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => {
      finish();
      resolve({ status: 0, body: null });
    };
    xhr.onabort = () => {
      finish();
      if (signal.aborted) reject(new Cancelled());
      else resolve({ status: 0, body: null }); // stalled
    };

    signal.addEventListener('abort', onAbort, { once: true });
    armStall();
    xhr.send(blob);
  });
}

const detailOf = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' && 'detail' in body && typeof (body as { detail: unknown }).detail === 'object'
    ? ((body as { detail: Record<string, unknown> }).detail ?? {})
    : {};

const messageOf = (body: unknown, fallback: string) => {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string') {
      return (d as { message: string }).message;
    }
  }
  return fallback;
};

class UploadManager {
  private snapshot: UploadSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private emitTimer = 0;

  private files = new Map<string, File>();
  private fileIds = new Map<string, string>();
  private uploadId: string | null = null;
  private chunkSize = 8 * 1024 * 1024;
  private options = { useGpu: true, folderId: null as number | null };
  private controller: AbortController | null = null;
  private samples: { t: number; bytes: number }[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  get busy() {
    return this.snapshot.phase === 'uploading' || this.snapshot.phase === 'committing';
  }

  // ----- state -----

  private set(patch: Partial<UploadSnapshot>, immediate = false) {
    this.snapshot = { ...this.snapshot, ...patch };
    if (immediate) {
      window.clearTimeout(this.emitTimer);
      this.emitTimer = 0;
      this.listeners.forEach((l) => l());
    } else if (!this.emitTimer) {
      // Progress events fire many times a second; re-render at most every 200 ms.
      this.emitTimer = window.setTimeout(() => {
        this.emitTimer = 0;
        this.listeners.forEach((l) => l());
      }, EMIT_INTERVAL_MS);
    }
  }

  private updateItem(key: string, patch: Partial<UploadItem>, immediate = false) {
    const items = this.snapshot.items.map((it) => (it.key === key ? { ...it, ...patch } : it));
    const sentBytes = items.reduce((n, it) => n + it.sent, 0);
    this.set({ items, sentBytes, ...this.speed(sentBytes) }, immediate);
  }

  private speed(sentBytes: number) {
    const now = performance.now();
    this.samples.push({ t: now, bytes: sentBytes });
    while (this.samples.length > 2 && now - this.samples[0].t > SPEED_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const elapsed = (now - first.t) / 1000;
    if (elapsed < 2) return { bytesPerSecond: this.snapshot.bytesPerSecond, etaSeconds: this.snapshot.etaSeconds };
    const bps = (sentBytes - first.bytes) / elapsed;
    const remaining = this.snapshot.totalBytes - sentBytes;
    return { bytesPerSecond: bps, etaSeconds: bps > 0 ? remaining / bps : null };
  }

  // ----- public API -----

  async start(files: File[], options: { useGpu: boolean; folderId: number | null }) {
    if (this.busy) return;
    this.reset();
    this.options = options;
    const items: UploadItem[] = files.map((f, i) => {
      const key = `${i}:${f.name}`;
      this.files.set(key, f);
      return { key, name: f.name, size: f.size, sent: 0, status: 'queued', attempt: 0 };
    });
    this.set({
      ...INITIAL,
      phase: 'uploading',
      items,
      totalBytes: items.reduce((n, it) => n + it.size, 0),
    }, true);

    try {
      const session = await api.createUpload();
      this.uploadId = session.upload_id;
      this.chunkSize = session.chunk_size;
    } catch (e) {
      this.set({ phase: 'idle', items: [], error: e instanceof Error ? e.message : 'Could not start the upload' }, true);
      return;
    }
    await this.run();
  }

  /** Retries the files that exhausted their attempts, resuming where each stopped. */
  async retryFailed() {
    if (this.snapshot.phase !== 'attention') return;
    this.snapshot.items
      .filter((it) => it.status === 'failed')
      .forEach((it) => this.updateItem(it.key, { status: 'queued', attempt: 0, error: undefined }));
    this.set({ phase: 'uploading', error: null }, true);
    await this.run();
  }

  /** Processes the files that did upload, leaving failed ones out. */
  async continueWithoutFailed() {
    if (this.snapshot.phase === 'attention') await this.commit();
  }

  async cancel() {
    this.controller?.abort();
    const id = this.uploadId;
    this.reset();
    this.set({ ...INITIAL }, true);
    if (id) api.discardUpload(id).catch(() => undefined);
  }

  /** Called by the processing view when the worker finishes. */
  finishProcessing(taskId: string, failed: boolean) {
    if (this.snapshot.taskId !== taskId) return;
    this.set({ phase: failed ? 'idle' : 'finished', taskId: null, finishedTaskId: failed ? null : taskId }, true);
  }

  dismiss() {
    if (!this.busy && this.snapshot.phase !== 'processing') this.set({ ...INITIAL }, true);
  }

  // ----- engine -----

  private reset() {
    this.controller?.abort();
    this.controller = null;
    this.files.clear();
    this.fileIds.clear();
    this.uploadId = null;
    this.samples = [];
  }

  private async run() {
    const controller = new AbortController();
    this.controller = controller;
    const queue = this.snapshot.items.filter((it) => it.status === 'queued').map((it) => it.key);

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length && !controller.signal.aborted) {
        const key = queue.shift()!;
        await this.uploadOne(key, controller.signal);
      }
    });

    try {
      await Promise.all(workers);
    } catch (e) {
      if (e instanceof Cancelled) return;
      throw e;
    }
    if (controller.signal.aborted) return;

    const items = this.snapshot.items;
    const done = items.filter((it) => it.status === 'done').length;
    const failed = items.filter((it) => it.status === 'failed').length;

    if (failed > 0) {
      this.set({ phase: 'attention', bytesPerSecond: null, etaSeconds: null }, true);
    } else if (done === 0) {
      this.set({ phase: 'idle', error: 'None of the selected files could be uploaded.' }, true);
    } else {
      await this.commit();
    }
  }

  private async uploadOne(key: string, signal: AbortSignal) {
    const file = this.files.get(key)!;
    const uploadId = this.uploadId!;
    let attempt = 0;

    const fail = (error: string, invalid = false) =>
      this.updateItem(key, { status: invalid ? 'invalid' : 'failed', error }, true);

    try {
      // Register (idempotent on the server: a retry gets the same file back).
      let state: UploadFileState | null = null;
      while (!state) {
        try {
          state = await api.registerUploadFile(uploadId, file.name, file.size);
          this.fileIds.set(key, state.file_id);
        } catch (e) {
          if (!isRetryable(e)) {
            if (e instanceof ApiError && e.status === 401) logout();
            throw new FatalItemError(e instanceof Error ? e.message : 'Upload rejected');
          }
          attempt = await this.backoff(key, attempt, signal);
        }
      }

      let offset = state.received;
      this.updateItem(key, { status: 'uploading', sent: offset, attempt: 0 });
      if (state.complete) {
        this.updateItem(key, { status: 'done', sent: file.size, pages: state.pages }, true);
        return;
      }

      const url = `/api/v1/uploads/${uploadId}/files/${state.file_id}`;
      while (offset < file.size) {
        const end = Math.min(offset + this.chunkSize, file.size);
        const base = offset;
        const res = await putChunk(
          `${url}?offset=${base}`,
          file.slice(base, end),
          (loaded) => this.updateItem(key, { sent: base + loaded }),
          signal,
        );

        if (res.status === 200) {
          const body = res.body as UploadFileState;
          offset = body.received;
          attempt = 0; // progress was made: the retry budget is per stuck chunk, not per file
          this.updateItem(key, { status: 'uploading', sent: offset, attempt: 0, pages: body.pages });
          continue;
        }

        const detail = detailOf(res.body);
        if (res.status === 401) {
          logout();
          throw new Cancelled();
        }
        if (res.status === 422 && detail.invalid) throw new FatalItemError(messageOf(res.body, 'Not a readable PDF'), true);
        if (res.status === 404 || res.status === 413) throw new FatalItemError(messageOf(res.body, 'Upload rejected'));
        if (res.status === 409 && typeof detail.received === 'number') {
          // Server and client disagree on position (e.g. a lost response): resume from the server's count.
          offset = detail.received;
          this.updateItem(key, { sent: offset });
          if (/already receiving/i.test(messageOf(res.body, ''))) attempt = await this.backoff(key, attempt, signal);
          continue;
        }

        // Network error, stall, proxy/5xx error, or rate limit: back off, then ask the
        // server where it actually got to before sending anything again.
        attempt = await this.backoff(key, attempt, signal);
        try {
          offset = (await api.uploadFileStatus(uploadId, state.file_id)).received;
          this.updateItem(key, { sent: offset });
        } catch {
          /* still unreachable: the next attempt tries again from the last known offset */
        }
      }

      this.updateItem(key, { status: 'done', sent: file.size }, true);
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted) throw new Cancelled();
      if (e instanceof FatalItemError) fail(e.message, e.invalid);
      else fail(e instanceof Error ? e.message : 'Upload failed');
    }
  }

  private async backoff(key: string, attempt: number, signal: AbortSignal): Promise<number> {
    const next = attempt + 1;
    if (next > MAX_ATTEMPTS) throw new Error('Connection kept failing');
    this.updateItem(key, { status: 'retrying', attempt: next }, true);
    await waitForOnline(signal);
    await sleep(backoffMs(next), signal);
    this.updateItem(key, { status: 'uploading' }, true);
    return next;
  }

  private async commit() {
    const uploadId = this.uploadId;
    if (!uploadId) return;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ phase: 'committing', bytesPerSecond: null, etaSeconds: null, error: null }, true);

    // Commit is idempotent on the server (a retry after a lost response returns the
    // same job), so network failures are retried like chunks rather than surfaced.
    for (let attempt = 1; ; attempt++) {
      try {
        const res: UploadResult = await api.commitUpload(uploadId, {
          use_gpu: this.options.useGpu,
          folder_id: this.options.folderId,
        });
        this.files.clear();
        this.set({ phase: 'processing', taskId: res.task_id }, true);
        return;
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) {
          logout();
          return;
        }
        if (!isRetryable(e) || attempt >= MAX_ATTEMPTS) {
          this.set({
            phase: 'attention',
            error: `Uploaded, but processing couldn't be started: ${e instanceof Error ? e.message : 'unknown error'}`,
          }, true);
          return;
        }
        try {
          await waitForOnline(controller.signal);
          await sleep(backoffMs(attempt), controller.signal);
        } catch {
          return; // cancelled
        }
      }
    }
  }
}

export const uploadManager = new UploadManager();

export const useUploadManager = () =>
  useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
