import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ProgressMessage } from '@/lib/types';

export interface JobProgress {
  files: Record<string, string>;
  completedPages: number;
  totalPages: number;
  completedFiles: number;
  totalFiles: number;
  eta: number | null;
}

const EMPTY: JobProgress = {
  files: {}, completedPages: 0, totalPages: 0, completedFiles: 0, totalFiles: 0, eta: null,
};

/**
 * Live job progress. The worker publishes *measured* throughput over the
 * WebSocket (see CLAUDE.md — ETA is measured, never estimated); the local timer
 * only counts the remainder down smoothly between those updates.
 */
export function useJobProgress(
  taskId: string | null,
  onDone: (taskId: string, failed: boolean, error?: string) => void,
): JobProgress {
  const [state, setState] = useState<JobProgress>(EMPTY);
  const etaRef = useRef<number | null>(null);
  // Keeps the effect keyed on taskId alone; a new callback identity must not
  // tear down and re-open the socket mid-job.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!taskId) return undefined;
    setState(EMPTY);
    etaRef.current = null;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/progress/${taskId}`);
    let settled = false;

    const apply = (d: ProgressMessage) => {
      if (d.status === 'PROCESSING') {
        if (typeof d.eta_seconds === 'number') etaRef.current = d.eta_seconds;
        setState((s) => ({
          files: d.files_status ?? s.files,
          completedPages: d.completed_pages ?? s.completedPages,
          totalPages: d.total_pages ?? s.totalPages,
          completedFiles: d.completed_files ?? s.completedFiles,
          totalFiles: d.total_files ?? s.totalFiles,
          eta: etaRef.current,
        }));
      } else if (d.status === 'SUCCESS' && !settled) {
        settled = true;
        doneRef.current(taskId, false);
      } else if (d.status === 'FAILED' && !settled) {
        settled = true;
        doneRef.current(taskId, true, d.error);
      }
    };

    ws.onmessage = (e) => {
      try {
        apply(JSON.parse(e.data as string) as ProgressMessage);
      } catch {
        /* malformed frame — the poll below still catches the terminal state */
      }
    };

    // Fallback poll: the socket can miss the terminal message entirely.
    const poll = window.setInterval(() => {
      api.status(taskId).then(apply).catch(() => undefined);
    }, 5000);

    const tick = window.setInterval(() => {
      setState((s) => (s.eta && s.eta > 0 ? { ...s, eta: s.eta - 1 } : s));
    }, 1000);

    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      ws.close();
    };
  }, [taskId]);

  return state;
}
