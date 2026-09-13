import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${Math.max(Math.round(seconds), 1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const formatDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
export const formatDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');
export const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
