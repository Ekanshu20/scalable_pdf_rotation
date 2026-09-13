import type {
  Folder, FileRecord, Job, ReviewManifest, ReviewGroupsResponse,
  UploadResult, User, JobStatus,
} from './types';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

// Must match the key static/login.html writes after a successful login.
const TOKEN_KEY = 'access_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = '/';
}

/** Token in a query string, for <img>/<a> URLs that cannot send headers. */
const qs = () => `token=${encodeURIComponent(getToken() ?? '')}`;

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, form } = opts;
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  let payload: BodyInit | undefined;

  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const res = await fetch(path, { method, headers, body: payload });

  if (res.status === 401) {
    logout();
    throw new ApiError('Session expired', 401);
  }

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) detail = data.detail;
    } catch {
      /* error body was not JSON */
    }
    throw new ApiError(detail, res.status);
  }

  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}

export interface ReviewParams {
  scope?: 'flagged' | 'all';
  offset?: number;
  limit?: number;
  file?: string | null;
  reason?: string | null;
  goto?: number | null;
  goto_file?: string | null;
}

export const api = {
  me: () => request<User>('/api/v1/auth/me'),

  folders: () => request<Folder[]>('/api/v1/folders'),
  createFolder: (name: string) => request<Folder>('/api/v1/folders', { method: 'POST', body: { name } }),
  renameFolder: (id: number, name: string) =>
    request<{ message: string; name: string }>(`/api/v1/folders/${id}`, { method: 'PUT', body: { name } }),
  deleteFolders: (folder_ids: number[]) =>
    request<{ deleted_count: number }>('/api/v1/folders/delete-batch', { method: 'POST', body: { folder_ids } }),
  folderFiles: (id: number) => request<{ files: FileRecord[]; jobs: unknown[] }>(`/api/v1/folders/${id}/files`),
  unfiledFiles: () => request<{ files: FileRecord[]; jobs: unknown[] }>('/api/v1/files/unfiled'),
  deleteFile: (id: number) => request<{ message: string }>(`/api/v1/folders/files/${id}`, { method: 'DELETE' }),
  deleteFiles: (file_ids: number[]) =>
    request<{ deleted_count: number }>('/api/v1/folders/files/delete-batch', { method: 'POST', body: { file_ids } }),
  mergeFolder: (id: number) => request<{ message: string }>(`/api/v1/folders/${id}/merge`, { method: 'POST' }),

  history: () => request<Job[]>('/api/v1/history'),
  deleteJob: (taskId: string) => request<{ message: string }>(`/api/v1/history/${taskId}`, { method: 'DELETE' }),
  moveJob: (taskId: string, folder_id: number | null) =>
    request<{ message: string }>(`/api/v1/jobs/${taskId}/move`, { method: 'POST', body: { folder_id } }),
  status: (taskId: string) =>
    request<{ task_id: string; status: JobStatus; details?: unknown; error?: string }>(`/api/v1/status/${taskId}`),

  upload: (files: File[], opts: { useGpu?: boolean; folderId?: number | null } = {}) => {
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    form.append('use_gpu', String(opts.useGpu ?? true));
    if (opts.folderId) form.append('folder_id', String(opts.folderId));
    return request<UploadResult>('/api/v1/upload', { method: 'POST', form });
  },

  review: (taskId: string, params: ReviewParams = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== null && v !== undefined && v !== '') search.set(k, String(v));
    });
    return request<ReviewManifest>(`/api/v1/review/${taskId}?${search}`);
  },
  reviewGroups: (taskId: string) => request<ReviewGroupsResponse>(`/api/v1/review/${taskId}/groups`),
  approvePage: (taskId: string, filename: string, page: number) =>
    request<{ reviewed: number }>(`/api/v1/review/${taskId}/approve`, { method: 'POST', body: { filename, page } }),
  rotatePage: (taskId: string, filename: string, page: number, rotation: number) =>
    request<{ message: string; image: string }>(`/api/v1/override/${taskId}`, {
      method: 'POST', body: { filename, page, rotation },
    }),
  groupAction: (
    taskId: string,
    body: { reason: string; angle: number; action: 'accept' | 'rotate'; rotate_by?: number },
  ) => request<{ pages: number; files: number }>(`/api/v1/review/${taskId}/group-action`, { method: 'POST', body }),
  pageText: (taskId: string, filename: string, page: number) =>
    request<{ files: { pages: { text: string }[] }[] }>(
      `/api/v1/text/${taskId}?filename=${encodeURIComponent(filename)}&page=${page}`,
    ),
};

// URLs the browser fetches directly (cannot carry an Authorization header).
export const urls = {
  thumb: (taskId: string, filename: string, page: number, side: 'before' | 'after') =>
    `/api/v1/page-thumb/${taskId}/${page}?filename=${encodeURIComponent(filename)}&side=${side}&${qs()}`,
  download: (taskId: string) => `/api/v1/download/${taskId}?${qs()}`,
  text: (taskId: string) => `/api/v1/text/${taskId}/download?${qs()}`,
  markdown: (taskId: string) => `/api/v1/markdown/${taskId}/download?${qs()}`,
  file: (fileId: number) => `/api/v1/folders/files/${fileId}/download?${qs()}`,
  folderZip: (folderId: number) => `/api/v1/folders/${folderId}/download_all?${qs()}`,
  bulkFolders: (ids: number[]) => `/api/v1/download_bulk?folder_ids=${ids.join(',')}&${qs()}`,
};
