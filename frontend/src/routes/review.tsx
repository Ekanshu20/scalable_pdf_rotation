import { useCallback } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Download, FileCode2, FileText, FileWarning, Layers, ListChecks } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GroupsView } from '@/features/review/groups-view';
import { PagesView } from '@/features/review/pages-view';
import { useCountUp } from '@/hooks/use-count-up';
import { urls } from '@/lib/api';
import { useReview } from '@/lib/queries';

/** Past this many flagged pages, per-page review stops scaling; lead with patterns. */
const GROUPS_THRESHOLD = 20;

type Patch = { view?: 'groups' | 'pages'; file?: string | null; reason?: string | null; offset?: number };

export function ReviewPage() {
  const { taskId = '' } = useParams();
  const [params, setParams] = useSearchParams();

  // Summary only — the header and the default view need it, not any pages.
  const { data: head, isLoading, error } = useReview(taskId, { limit: 1 });
  const summary = head?.summary;

  const bulk = (summary?.needs_review ?? 0) >= GROUPS_THRESHOLD;
  const view = (params.get('view') as 'groups' | 'pages' | null) ?? (bulk ? 'groups' : 'pages');
  const file = params.get('file');
  const reason = params.get('reason');
  const offset = Math.max(Number(params.get('offset')) || 0, 0);

  // Everything that defines "where you are" lives in the URL, so refresh, Back
  // and a shared link all land on the same page of the same file.
  const update = useCallback(
    (patch: Patch, replace = false) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          Object.entries(patch).forEach(([k, v]) => {
            if (v === null || v === undefined || v === '' || (k === 'offset' && v === 0)) next.delete(k);
            else next.set(k, String(v));
          });
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );

  const remaining = summary ? Math.max(summary.needs_review - summary.reviewed, 0) : 0;
  const shownRemaining = useCountUp(remaining);
  const shownAuto = useCountUp(summary?.auto_corrected ?? 0);
  const total = summary?.needs_review ?? 0;
  const pct = total ? Math.min((summary!.reviewed / total) * 100, 100) : 0;

  return (
    <>
      <PageHeader
        back={
          <Link
            to="/history"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            History
          </Link>
        }
        title="Review pages"
        description={
          summary
            ? `${summary.total_pages.toLocaleString()} pages - ${summary.needs_review.toLocaleString()} flagged`
            : error
              ? 'Unavailable'
              : 'Loading...'
        }
        actions={
          <>
            <Button variant="secondary" asChild>
              <a href={urls.text(taskId)}>
                <FileText />
                Text
              </a>
            </Button>
            <Button variant="secondary" asChild>
              <a href={urls.markdown(taskId)}>
                <FileCode2 />
                Markdown
              </a>
            </Button>
            <Button asChild>
              <a href={urls.download(taskId)}>
                <Download />
                Download PDF
              </a>
            </Button>
          </>
        }
      />

      {isLoading ? (
        <Skeleton className="mb-6 h-14" />
      ) : summary ? (
        <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-card px-5 py-3.5 shadow-sm">
          <span className="flex items-center gap-2 text-sm">
            <span className="size-2 rounded-full bg-warning" />
            <strong className="tabular">{shownRemaining.toLocaleString()}</strong>
            <span className="text-muted-foreground">need review</span>
          </span>
          <span className="flex items-center gap-2 text-sm">
            <span className="size-2 rounded-full bg-success" />
            <strong className="tabular">{shownAuto.toLocaleString()}</strong>
            <span className="text-muted-foreground">auto-corrected</span>
          </span>
          <div className="flex min-w-[12rem] flex-1 items-center justify-end gap-3">
            <Progress value={pct} className="h-1.5 max-w-[10rem]" indicatorClassName="bg-success" />
            <span className="whitespace-nowrap text-sm text-muted-foreground tabular">
              {summary.reviewed.toLocaleString()} of {total.toLocaleString()} reviewed
            </span>
          </div>
        </div>
      ) : null}

      {bulk && (
        <Tabs
          value={view}
          onValueChange={(v) => update({ view: v as 'groups' | 'pages', reason: null, file: null, offset: 0 })}
          className="mb-5"
        >
          <TabsList>
            <TabsTrigger value="groups">
              <Layers />
              By pattern
            </TabsTrigger>
            <TabsTrigger value="pages">
              <ListChecks />
              Page by page
            </TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {isLoading ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <Card>
          <EmptyState
            icon={FileWarning}
            title="Review data isn't available"
            description={`${error.message} Processing results are kept for 24 hours; the corrected PDF can still be downloaded.`}
            action={
              <Button variant="secondary" asChild>
                <Link to="/history">Back to history</Link>
              </Button>
            }
          />
        </Card>
      ) : view === 'groups' ? (
        <GroupsView taskId={taskId} onDrill={(r) => update({ view: 'pages', reason: r, file: null, offset: 0 })} />
      ) : (
        <PagesView taskId={taskId} reason={reason} file={file} offset={offset} onParams={update} />
      )}
    </>
  );
}
