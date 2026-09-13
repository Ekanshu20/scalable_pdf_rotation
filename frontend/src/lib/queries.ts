import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, ApiError, type ReviewParams } from './api';
import type { Folder, Job, ReviewManifest, ReviewGroupsResponse, User } from './types';

/**
 * Query keys are structured so an invalidation can target a whole area
 * (`['review', taskId]`) or one exact query.
 */
export const keys = {
  me: ['me'] as const,
  folders: ['folders'] as const,
  folderFiles: (id: number | 'unfiled') => ['folderFiles', id] as const,
  history: ['history'] as const,
  review: (taskId: string, params?: ReviewParams) =>
    params ? (['review', taskId, params] as const) : (['review', taskId] as const),
  reviewGroups: (taskId: string) => ['reviewGroups', taskId] as const,
  pageText: (taskId: string, filename: string, page: number) =>
    ['pageText', taskId, filename, page] as const,
};

const onError = (error: unknown) => {
  toast.error(error instanceof ApiError ? error.message : 'Something went wrong');
};

// ===== Queries =====

export const useMe = (): UseQueryResult<User> =>
  useQuery({ queryKey: keys.me, queryFn: api.me, staleTime: Infinity, retry: false });

export const useFolders = (): UseQueryResult<Folder[]> =>
  useQuery({ queryKey: keys.folders, queryFn: api.folders });

export const useHistory = (): UseQueryResult<Job[]> =>
  useQuery({ queryKey: keys.history, queryFn: api.history });

export const useFolderFiles = (id: number | 'unfiled') =>
  useQuery({
    queryKey: keys.folderFiles(id),
    queryFn: () => (id === 'unfiled' ? api.unfiledFiles() : api.folderFiles(id)),
  });

export const useReview = (taskId: string, params: ReviewParams): UseQueryResult<ReviewManifest> =>
  useQuery({
    queryKey: keys.review(taskId, params),
    queryFn: () => api.review(taskId, params),
    // Keeps the previous page on screen while the next one loads instead of
    // collapsing to a spinner on every pagination click.
    placeholderData: (prev) => prev,
  });

export const useReviewGroups = (taskId: string): UseQueryResult<ReviewGroupsResponse> =>
  useQuery({ queryKey: keys.reviewGroups(taskId), queryFn: () => api.reviewGroups(taskId) });

export const usePageText = (taskId: string, filename: string, page: number, enabled: boolean) =>
  useQuery({
    queryKey: keys.pageText(taskId, filename, page),
    queryFn: () => api.pageText(taskId, filename, page),
    enabled,
    staleTime: 5 * 60 * 1000,
    select: (data) => data.files?.[0]?.pages?.[0]?.text ?? '',
  });

// ===== Mutations =====

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createFolder(name),
    onSuccess: (folder) => {
      toast.success(`Created "${folder.name}"`);
      qc.invalidateQueries({ queryKey: keys.folders });
    },
    onError,
  });
}

export function useRenameFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameFolder(id, name),
    onSuccess: () => {
      toast.success('Folder renamed');
      qc.invalidateQueries({ queryKey: keys.folders });
    },
    onError,
  });
}

export function useDeleteFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.deleteFolders(ids),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted_count} folder${res.deleted_count === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: keys.folders });
      qc.invalidateQueries({ queryKey: keys.history });
    },
    onError,
  });
}

export function useDeleteFiles(scope: number | 'unfiled') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => api.deleteFiles(ids),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted_count} file${res.deleted_count === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: keys.folderFiles(scope) });
      qc.invalidateQueries({ queryKey: keys.folders });
    },
    onError,
  });
}

export function useMergeFolder(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.mergeFolder(id),
    onSuccess: (res) => {
      toast.success(res.message);
      qc.invalidateQueries({ queryKey: keys.folderFiles(id) });
    },
    onError,
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (taskId: string) => api.deleteJob(taskId),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.history }),
    onError,
  });
}

export function useMoveJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, folderId }: { taskId: string; folderId: number | null }) =>
      api.moveJob(taskId, folderId),
    onSuccess: () => {
      toast.success('Job moved');
      qc.invalidateQueries({ queryKey: keys.history });
      qc.invalidateQueries({ queryKey: keys.folders });
    },
    onError,
  });
}

/**
 * Approving is optimistic: the card marks itself reviewed immediately and rolls
 * back if the server rejects it. Reviewing hundreds of pages should never wait
 * on a round trip.
 */
export function useApprovePage(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ filename, page }: { filename: string; page: number }) =>
      api.approvePage(taskId, filename, page),
    onMutate: async ({ filename, page }) => {
      await qc.cancelQueries({ queryKey: keys.review(taskId) });
      const previous = qc.getQueriesData<ReviewManifest>({ queryKey: keys.review(taskId) });

      qc.setQueriesData<ReviewManifest>({ queryKey: keys.review(taskId) }, (old) =>
        old
          ? {
              ...old,
              summary: { ...old.summary, reviewed: old.summary.reviewed + 1 },
              files: old.files.map((f) =>
                f.filename === filename ? { ...f, reviewed: Math.min(f.reviewed + 1, f.needs_review) } : f,
              ),
              pages: old.pages.map((p) =>
                p.filename === filename && p.page === page ? { ...p, reviewed: true } : p,
              ),
            }
          : old,
      );

      return { previous };
    },
    onError: (error, _vars, context) => {
      context?.previous?.forEach(([key, data]) => qc.setQueryData(key, data));
      onError(error);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.review(taskId) });
      qc.invalidateQueries({ queryKey: keys.reviewGroups(taskId) });
    },
  });
}

export function useRotatePage(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ filename, page, rotation }: { filename: string; page: number; rotation: number }) =>
      api.rotatePage(taskId, filename, page, rotation),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.review(taskId) });
      qc.invalidateQueries({ queryKey: keys.reviewGroups(taskId) });
    },
    onError,
  });
}

export function useGroupAction(taskId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { reason: string; angle: number; action: 'accept' | 'rotate'; rotate_by?: number }) =>
      api.groupAction(taskId, body),
    onSuccess: (res) => {
      toast.success(`${res.pages} page(s) across ${res.files} file(s) updated`);
      qc.invalidateQueries({ queryKey: keys.reviewGroups(taskId) });
      qc.invalidateQueries({ queryKey: keys.review(taskId) });
    },
    onError,
  });
}
