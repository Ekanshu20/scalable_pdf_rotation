import { forwardRef, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowRight, Check, ChevronDown, FileText, FlipVertical2, Loader2, RotateCcw, RotateCw,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { urls } from '@/lib/api';
import { useApprovePage, usePageText, useRotatePage } from '@/lib/queries';
import { REVIEW_REASON_LABELS, type ReviewPage } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useHotkeys } from '@/hooks/use-hotkeys';

const ANGLES = ['0', '90', '180', '270'] as const;

function ScoreBars({ scores }: { scores: Record<string, number> }) {
  const max = Math.max(...Object.values(scores), 1);
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Confidence by rotation</p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {ANGLES.map((angle) => {
          const val = scores[angle] ?? 0;
          const best = val === max && val > 0;
          return (
            <div key={angle} className="space-y-1">
              <div className={cn('flex justify-between text-xs tabular', best ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                <span>{angle} deg</span>
                <span>{val}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', best ? 'bg-primary' : 'bg-muted-foreground/40')}
                  style={{ width: `${Math.max((val / max) * 100, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Pane({ label, caption, src, alt, tone }: { label: string; caption: string; src: string; alt: string; tone: 'before' | 'after' }) {
  return (
    <figure className="min-w-0 flex-1 space-y-2">
      <figcaption className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            tone === 'after' ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {label}
        </span>
        {caption}
      </figcaption>
      {/* Fixed-size frame: a 90 degree rotation changes the image's aspect ratio,
          and a content-sized frame reflowed the whole page ("shake"). */}
      <div className="flex h-[22.5rem] items-center justify-center overflow-hidden rounded-md border border-border bg-[hsl(var(--page))] p-2">
        <img loading="lazy" src={src} alt={alt} className="max-h-full max-w-full object-contain" />
      </div>
    </figure>
  );
}

interface PageCardProps {
  page: ReviewPage;
  taskId: string;
  active: boolean;
  onFocus: () => void;
}

export const PageCard = forwardRef<HTMLDivElement, PageCardProps>(({ page, taskId, active, onFocus }, ref) => {
  const approve = useApprovePage(taskId);
  const rotate = useRotatePage(taskId);
  const [afterSrc, setAfterSrc] = useState(() => urls.thumb(taskId, page.filename, page.page, 'after'));
  const [adjusted, setAdjusted] = useState(false);
  const [textOpen, setTextOpen] = useState(false);
  const text = usePageText(taskId, page.filename, page.page, textOpen);

  useEffect(() => {
    setAfterSrc(urls.thumb(taskId, page.filename, page.page, 'after'));
    setAdjusted(false);
    setTextOpen(false);
  }, [taskId, page.filename, page.page]);

  const busy = approve.isPending || rotate.isPending;
  const reviewed = page.reviewed || adjusted;

  const doApprove = () => {
    if (busy || page.reviewed) return;
    approve.mutate({ filename: page.filename, page: page.page });
  };

  const doRotate = (rotation: number) => {
    if (busy) return;
    rotate.mutate(
      { filename: page.filename, page: page.page, rotation },
      {
        onSuccess: (res) => {
          // The endpoint returns the freshly rendered page, so the preview
          // updates without waiting on the thumbnail cache.
          if (res.image) setAfterSrc(`data:image/png;base64,${res.image}`);
          setAdjusted(true);
        },
      },
    );
  };

  useHotkeys(
    { a: doApprove, ArrowLeft: () => doRotate(270), ArrowRight: () => doRotate(90) },
    active,
  );

  const reasonLabel = page.reason
    ? REVIEW_REASON_LABELS[page.reason]
    : page.needs_review
      ? 'Uncertain'
      : 'High confidence';

  return (
    <div
      ref={ref}
      onClick={onFocus}
      className={cn(
        'space-y-5 rounded-lg border bg-card p-5 shadow-sm transition-[border-color,box-shadow]',
        active ? 'border-primary/60 ring-2 ring-primary/15' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium" title={page.filename}>
            {page.filename}
            <span className="mx-1.5 text-muted-foreground/60">/</span>
            <span className="text-muted-foreground">Page {page.page + 1}</span>
          </p>
          <p className="flex items-center gap-1.5 text-sm text-warning">
            <AlertTriangle className="size-3.5 shrink-0" />
            {reasonLabel}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {page.skew ? <Badge variant="outline">skew {page.skew} deg</Badge> : null}
          <Badge variant="primary">{adjusted ? 'adjusted manually' : `detected ${page.angle} deg`}</Badge>
          {reviewed && (
            <Badge variant="success">
              <Check />
              reviewed
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 md:flex-row md:items-center">
        <Pane
          tone="before"
          label="Before"
          caption="original upload"
          src={urls.thumb(taskId, page.filename, page.page, 'before')}
          alt={`Page ${page.page + 1} before`}
        />
        <ArrowRight className="hidden size-5 shrink-0 text-muted-foreground md:block" />
        <Pane
          tone="after"
          label="After"
          caption={adjusted ? 'adjusted' : page.angle === 0 ? 'unchanged' : `rotated ${page.angle} deg`}
          src={afterSrc}
          alt={`Page ${page.page + 1} after`}
        />
      </div>

      {Object.keys(page.scores ?? {}).length > 0 && <ScoreBars scores={page.scores} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={reviewed ? 'secondary' : 'default'} disabled={busy || page.reviewed} onClick={doApprove}>
          <Check />
          {page.reviewed ? 'Approved' : 'Looks right'}
          {!page.reviewed && <Kbd>A</Kbd>}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => doRotate(90)}>
          <RotateCw />
          Rotate 90
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => doRotate(270)}>
          <RotateCcw />
          Rotate -90
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => doRotate(180)}>
          <FlipVertical2 />
          180
        </Button>
        {busy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="rounded-md border border-border">
        <button
          type="button"
          onClick={() => setTextOpen((o) => !o)}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40"
          aria-expanded={textOpen}
        >
          <FileText className="size-4 text-muted-foreground" />
          <span className="font-medium">Extracted text</span>
          {page.word_count ? <span className="text-xs text-muted-foreground">{page.word_count} words</span> : null}
          <ChevronDown className={cn('ml-auto size-4 transition-transform', textOpen && 'rotate-180')} />
        </button>
        {textOpen && (
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
            {text.isLoading
              ? 'Loading...'
              : text.isError
                ? `Could not load text: ${text.error.message}`
                : text.data || 'No text recognised on this page.'}
          </pre>
        )}
      </div>
    </div>
  );
});
PageCard.displayName = 'PageCard';
