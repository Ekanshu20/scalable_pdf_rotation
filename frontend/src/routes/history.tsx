import { useNavigate } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Download, Folder, History as HistoryIcon, RotateCw, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { urls } from '@/lib/api';
import { useDeleteJob, useFolders, useHistory, useMoveJob } from '@/lib/queries';
import type { Job, JobStatus } from '@/lib/types';
import { formatDateTime, plural } from '@/lib/utils';

const STATUS: Record<JobStatus, { label: string; variant: BadgeProps['variant'] }> = {
  SUCCESS: { label: 'Completed', variant: 'success' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  PROCESSING: { label: 'Processing', variant: 'warning' },
  PENDING: { label: 'Queued', variant: 'default' },
};

function JobRow({ job, onDelete }: { job: Job; onDelete: () => void }) {
  const navigate = useNavigate();
  const { data: folders = [] } = useFolders();
  const move = useMoveJob();
  const status = STATUS[job.status] ?? STATUS.PENDING;
  const done = job.status === 'SUCCESS';
  const names = job.filenames?.length ? job.filenames : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 shadow-sm md:flex-row md:items-center">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant={status.variant}>{status.label}</Badge>
          <span className="text-muted-foreground">{formatDateTime(job.created_at)}</span>
          {job.folder_name && (
            <Badge variant="outline">
              <Folder />
              {job.folder_name}
            </Badge>
          )}
        </div>
        <p className="truncate text-sm font-medium" title={names?.join(', ')}>
          {names
            ? names.length > 3
              ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more`
              : names.join(', ')
            : `${plural(job.total_files, 'file')} - ${plural(job.total_pages, 'page')}`}
        </p>
        {done && (job.pages_rotated > 0 || job.pages_unchanged > 0) && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="primary">
              <RotateCw />
              {job.pages_rotated.toLocaleString()} rotated
            </Badge>
            <Badge>
              <CheckCircle2 />
              {job.pages_unchanged.toLocaleString()} unchanged
            </Badge>
          </div>
        )}
        {job.error_message && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {job.error_message}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {done && (
          <>
            <select
              aria-label="Move to folder"
              value={job.folder_id ?? ''}
              disabled={move.isPending}
              onChange={(e) =>
                move.mutate({ taskId: job.task_id, folderId: e.target.value ? Number(e.target.value) : null })
              }
              className="h-8 max-w-[11rem] rounded-md border border-input bg-card px-2 text-xs shadow-sm"
            >
              <option value="">Unfiled</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={() => navigate(`/review/${job.task_id}`)}>
              Review
            </Button>
            <Button size="sm" asChild>
              <a href={urls.download(job.task_id)}>
                <Download />
                Download
              </a>
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Remove from history" onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </div>
  );
}

export function HistoryPage() {
  const { data: jobs = [], isLoading } = useHistory();
  const deleteJob = useDeleteJob();
  const { confirm, dialog } = useConfirm();

  return (
    <>
      <PageHeader
        title="History"
        description={isLoading ? 'Loading...' : plural(jobs.length, 'recent job')}
      />

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card">
          <EmptyState
            icon={HistoryIcon}
            title="No jobs yet"
            description="Processed uploads show up here with what was corrected."
          />
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <JobRow
              key={job.task_id}
              job={job}
              onDelete={() =>
                confirm({
                  title: 'Remove from history',
                  description: 'This removes the history entry. Processed files are not deleted.',
                  confirmLabel: 'Remove',
                  destructive: true,
                  onConfirm: () => deleteJob.mutateAsync(job.task_id),
                })
              }
            />
          ))}
        </div>
      )}

      {dialog}
    </>
  );
}
