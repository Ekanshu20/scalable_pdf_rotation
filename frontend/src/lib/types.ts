export type ReviewReason =
  | 'no_text'
  | 'close_to_zero'
  | 'ambiguous'
  | 'blank'
  | 'skewed'
  | 'error';

export interface User {
  id: number;
  email: string;
}

export interface Folder {
  id: number;
  name: string;
  file_count: number;
  created_at: string;
}

export interface FileRecord {
  id: number;
  filename: string;
  available: boolean;
  created_at: string;
}

export type JobStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export interface Job {
  task_id: string;
  status: JobStatus;
  total_files: number;
  total_pages: number;
  pages_rotated: number;
  pages_unchanged: number;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
  folder_id: number | null;
  folder_name: string | null;
  filenames: string[];
}

export interface ReviewPage {
  filename: string;
  page: number;
  angle: number;
  method: string | null;
  scores: Record<string, number>;
  reason: ReviewReason | null;
  skew: number | null;
  ink_ratio: number | null;
  word_count: number | null;
  needs_review: boolean;
  reviewed: boolean;
}

export interface ReviewFile {
  filename: string;
  total_pages: number;
  needs_review: number;
  reviewed: number;
  all_low_confidence: boolean;
}

export interface ReviewSummary {
  total_pages: number;
  needs_review: number;
  auto_corrected: number;
  reviewed: number;
  all_low_confidence?: boolean;
  groups?: number;
}

export interface ReviewManifest {
  task_id: string;
  goto_found: boolean | null;
  summary: ReviewSummary;
  files: ReviewFile[];
  pages: ReviewPage[];
  offset: number;
  limit: number;
  total: number;
}

export interface ReviewGroup {
  key: string;
  reason: ReviewReason | 'unknown';
  angle: number;
  label: string;
  hint: string;
  count: number;
  reviewed: number;
  files: number;
  sample: { filename: string; page: number }[];
}

export interface ReviewGroupsResponse {
  task_id: string;
  summary: ReviewSummary;
  groups: ReviewGroup[];
}

export interface UploadResult {
  message: string;
  task_id: string;
  session_id: string;
  total_files: number;
  total_pages: number;
}

/** Live progress pushed over the WebSocket by the worker. */
export interface ProgressMessage {
  task_id: string;
  status: JobStatus | 'DISCONNECTED';
  completed_files?: number;
  total_files?: number;
  filename?: string;
  files_status?: Record<string, string>;
  completed_pages?: number;
  total_pages?: number;
  elapsed_seconds?: number;
  pages_per_second?: number;
  eta_seconds?: number | null;
  error?: string;
}

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  no_text: 'No readable text found at any rotation',
  close_to_zero: 'Barely beat leaving the page unrotated',
  ambiguous: 'Two rotations scored almost the same',
  blank: 'Page appears to be blank',
  skewed: 'Page is tilted and may need straightening',
  error: 'Page failed to process',
};
