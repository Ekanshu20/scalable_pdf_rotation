import { AlertTriangle, ArrowRight, CheckCircle2, FlipVertical2, RotateCcw, RotateCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { urls } from '@/lib/api';
import { useGroupAction, useReviewGroups } from '@/lib/queries';
import type { ReviewGroup } from '@/lib/types';
import { cn, plural } from '@/lib/utils';

function GroupCard({
  group, taskId, onDrill,
}: { group: ReviewGroup; taskId: string; onDrill: (reason: string) => void }) {
  const action = useGroupAction(taskId);
  const { confirm, dialog } = useConfirm();
  const done = group.reviewed >= group.count;
  const busy = action.isPending;

  const run = (kind: 'accept' | 'rotate', rotateBy = 0) =>
    confirm({
      title: kind === 'accept' ? 'Accept pages' : 'Rotate pages',
      description:
        kind === 'accept'
          ? `Accept all ${plural(group.count, 'page')} as they are?`
          : `Rotate all ${plural(group.count, 'page')} by ${rotateBy === 270 ? '-90' : rotateBy} degrees?`,
      confirmLabel: kind === 'accept' ? 'Accept all' : 'Rotate all',
      onConfirm: () =>
        action.mutateAsync({ reason: group.reason, angle: group.angle, action: kind, rotate_by: rotateBy }),
    });

  return (
    <Card className={cn('overflow-hidden', done && 'opacity-70')}>
      <div className="space-y-2 p-5">
        <div className="flex flex-wrap items-center gap-2">
          {done ? (
            <CheckCircle2 className="size-4 text-success" />
          ) : (
            <AlertTriangle className="size-4 text-warning" />
          )}
          <h3 className="font-semibold">{group.label}</h3>
          {done && <Badge variant="success">Done</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          <strong className="text-foreground tabular">{group.count.toLocaleString()}</strong>{' '}
          {group.count === 1 ? 'page' : 'pages'} across{' '}
          <strong className="text-foreground">{plural(group.files, 'file')}</strong>
          {' - '}
          {group.angle === 0 ? 'left unrotated' : `corrected to ${group.angle} degrees`}
          {group.reviewed ? ` - ${group.reviewed.toLocaleString()} already reviewed` : ''}
        </p>
        {group.hint && <p className="text-sm text-muted-foreground">{group.hint}</p>}
      </div>

      {group.sample.length > 0 && (
        <div className="flex gap-3 overflow-x-auto border-y border-border bg-muted/40 px-5 py-4">
          {group.sample.map((s) => (
            <figure key={`${s.filename}:${s.page}`} className="w-28 shrink-0 space-y-1.5">
              <div className="flex h-36 items-center justify-center overflow-hidden rounded border border-border bg-[hsl(var(--page))]">
                <img
                  loading="lazy"
                  src={urls.thumb(taskId, s.filename, s.page, 'after')}
                  alt={`${s.filename} page ${s.page + 1}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <figcaption className="truncate text-[11px] text-muted-foreground" title={s.filename}>
                {s.filename} - p{s.page + 1}
              </figcaption>
            </figure>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 p-4">
        <Button size="sm" disabled={busy} onClick={() => run('accept')}>
          <CheckCircle2 />
          Accept all {group.count.toLocaleString()}
        </Button>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
        <span className="text-xs text-muted-foreground">All turned the same way?</span>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run('rotate', 90)}>
          <RotateCw />
          90
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run('rotate', 180)}>
          <FlipVertical2 />
          180
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run('rotate', 270)}>
          <RotateCcw />
          -90
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onDrill(group.reason)}>
          Review individually
          <ArrowRight />
        </Button>
      </div>
      {dialog}
    </Card>
  );
}

export function GroupsView({ taskId, onDrill }: { taskId: string; onDrill: (reason: string) => void }) {
  const { data, isLoading } = useReviewGroups(taskId);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-64" />
        ))}
      </div>
    );
  }

  if (data.groups.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CheckCircle2}
          title="Nothing needs review"
          description="Every page was corrected with high confidence."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {data.groups.map((g) => (
        <GroupCard key={g.key} group={g} taskId={taskId} onDrill={onDrill} />
      ))}
      <p className="flex items-center justify-center gap-1.5 py-2 text-sm text-muted-foreground">
        <CheckCircle2 className="size-4 text-success" />
        {(data.summary.auto_corrected ?? 0).toLocaleString()} pages were corrected with high confidence
      </p>
    </div>
  );
}
