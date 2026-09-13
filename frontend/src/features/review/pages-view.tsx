import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, FileText, Keyboard, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { useReview } from '@/lib/queries';
import { REVIEW_REASON_LABELS, type ReviewFile, type ReviewReason } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useHotkeys } from '@/hooks/use-hotkeys';
import { PageCard } from './page-card';

export const PAGE_SIZE = 10;

function FileRail({
  files, activeFile, onSelect,
}: { files: ReviewFile[]; activeFile: string | null; onSelect: (f: string) => void }) {
  const [showClean, setShowClean] = useState(false);
  const flagged = files.filter((f) => f.needs_review > 0);
  const clean = files.filter((f) => f.needs_review === 0);

  const item = (f: ReviewFile, subtle = false) => {
    const done = f.reviewed >= f.needs_review;
    return (
      <button
        key={f.filename}
        type="button"
        title={f.filename}
        onClick={() => onSelect(f.filename)}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
          f.filename === activeFile
            ? 'bg-accent font-medium text-accent-foreground'
            : 'text-foreground hover:bg-muted',
          subtle && f.filename !== activeFile && 'text-muted-foreground',
        )}
      >
        <FileText className="size-4 shrink-0 opacity-60" />
        <span className="min-w-0 flex-1 truncate">{f.filename}</span>
        <span className={cn('shrink-0 text-xs tabular', done && !subtle ? 'text-success' : 'text-muted-foreground')}>
          {subtle ? `${f.total_pages}p` : done ? <CheckCircle2 className="size-3.5" /> : `${f.reviewed}/${f.needs_review}`}
        </span>
      </button>
    );
  };

  return (
    <aside className="space-y-1 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto">
      <p className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs review</p>
      {flagged.length === 0 && <p className="px-2.5 text-sm text-muted-foreground">Nothing flagged</p>}
      {flagged.map((f) => item(f))}
      {clean.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowClean((s) => !s)}
            className="flex w-full items-center gap-2 px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <CheckCircle2 className="size-3.5 text-success" />
            {clean.length} file{clean.length === 1 ? '' : 's'} needed no review
            <ChevronDown className={cn('ml-auto size-3.5 transition-transform', showClean && 'rotate-180')} />
          </button>
          {showClean && <div className="mt-1 space-y-1">{clean.map((f) => item(f, true))}</div>}
        </div>
      )}
    </aside>
  );
}

interface PagesViewProps {
  taskId: string;
  reason: string | null;
  file: string | null;
  offset: number;
  onParams: (patch: { file?: string | null; offset?: number; reason?: string | null }, replace?: boolean) => void;
}

export function PagesView({ taskId, reason, file, offset, onParams }: PagesViewProps) {
  const { data, isLoading, isPlaceholderData } = useReview(taskId, {
    scope: 'flagged', offset, limit: PAGE_SIZE, file, reason,
  });
  const [cursor, setCursor] = useState(0);
  const [gotoValue, setGotoValue] = useState('');
  const [going, setGoing] = useState(false);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const topRef = useRef<HTMLDivElement>(null);

  // Land on the first file that still needs attention instead of mixing every
  // file together. `replace` so Back doesn't bounce through the unfiltered URL.
  useEffect(() => {
    if (!data || file || reason || data.files.length <= 1) return;
    const first =
      data.files.find((f) => f.needs_review > f.reviewed) ?? data.files.find((f) => f.needs_review > 0);
    if (first) onParams({ file: first.filename, offset: 0 }, true);
  }, [data, file, reason, onParams]);

  // New page of results: reset the keyboard cursor.
  useEffect(() => {
    setCursor(0);
  }, [offset, file, reason]);

  const pages = data?.pages ?? [];
  const total = data?.total ?? 0;
  const shownTo = Math.min(offset + PAGE_SIZE, total);

  const goOffset = (next: number) => {
    onParams({ offset: next });
    topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const step = (dir: 1 | -1) => {
    const next = cursor + dir;
    if (next < 0) {
      if (offset > 0) goOffset(Math.max(offset - PAGE_SIZE, 0));
      return;
    }
    if (next >= pages.length) {
      if (shownTo < total) goOffset(offset + PAGE_SIZE);
      return;
    }
    setCursor(next);
    cardRefs.current[next]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  useHotkeys({ j: () => step(1), k: () => step(-1) });

  const jump = async () => {
    const n = Number(gotoValue);
    if (!Number.isInteger(n) || n < 1) return;
    setGoing(true);
    try {
      const res = await api.review(taskId, {
        scope: 'flagged', limit: PAGE_SIZE, file, reason, goto: n, goto_file: file,
      });
      if (res.goto_found === false) {
        toast.info(reason ? 'That page is not in this group.' : "That page isn't flagged for review.");
        return;
      }
      goOffset(res.offset);
      setGotoValue('');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not jump to that page');
    } finally {
      setGoing(false);
    }
  };

  if (isLoading || !data) {
    return <Skeleton className="h-[40rem]" />;
  }

  const showRail = data.files.length > 1;

  return (
    <div ref={topRef} className="scroll-mt-20 space-y-4">
      {reason && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-accent/40 px-4 py-2.5 text-sm">
          <span>
            Showing only: <strong>{REVIEW_REASON_LABELS[reason as ReviewReason] ?? reason}</strong>
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => onParams({ reason: null, offset: 0 })}>
            <X />
            Clear filter
          </Button>
        </div>
      )}

      <div className={cn('grid gap-6', showRail && 'lg:grid-cols-[15rem_1fr]')}>
        {showRail && (
          <FileRail files={data.files} activeFile={file} onSelect={(f) => onParams({ file: f, offset: 0 })} />
        )}

        <div className={cn('min-w-0 space-y-4 transition-opacity', isPlaceholderData && 'opacity-60')}>
          {pages.length === 0 ? (
            <Card>
              <EmptyState
                icon={CheckCircle2}
                title="Nothing needs review"
                description="Every page here was corrected with high confidence."
              />
            </Card>
          ) : (
            pages.map((p, i) => (
              <PageCard
                key={`${p.filename}:${p.page}`}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                page={p}
                taskId={taskId}
                active={i === cursor}
                onFocus={() => setCursor(i)}
              />
            ))
          )}

          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={offset === 0}
                  onClick={() => goOffset(Math.max(offset - PAGE_SIZE, 0))}
                >
                  <ChevronLeft />
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground tabular">
                  {(offset + 1).toLocaleString()}-{shownTo.toLocaleString()} of {total.toLocaleString()}
                </span>
                <Button size="sm" variant="secondary" disabled={shownTo >= total} onClick={() => goOffset(offset + PAGE_SIZE)}>
                  Next
                  <ChevronRight />
                </Button>
              </div>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void jump();
                }}
              >
                <label htmlFor="goto-page" className="text-sm text-muted-foreground">
                  Go to page
                </label>
                <Input
                  id="goto-page"
                  type="number"
                  min={1}
                  placeholder="#"
                  value={gotoValue}
                  onChange={(e) => setGotoValue(e.target.value)}
                  className="h-8 w-20"
                />
                <Button size="sm" type="submit" variant="secondary" loading={going} disabled={!gotoValue}>
                  Go
                </Button>
              </form>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5 font-medium">
              <Keyboard className="size-3.5" />
              Shortcuts
            </span>
            <span className="flex items-center gap-1">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
              next / previous
            </span>
            <span className="flex items-center gap-1">
              <Kbd>A</Kbd>
              approve
            </span>
            <span className="flex items-center gap-1">
              <Kbd>&larr;</Kbd>
              <Kbd>&rarr;</Kbd>
              rotate
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
