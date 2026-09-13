import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2, Clock, Download, FileText, Loader2, UploadCloud, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { urls } from '@/lib/api';
import { useFolders, useUpload } from '@/lib/queries';
import { cn, formatDuration, plural } from '@/lib/utils';
import { useCountUp } from '@/hooks/use-count-up';
import { useJobProgress } from '@/hooks/use-job-progress';

function ActiveJob({
  taskId,
  onDone,
}: {
  taskId: string;
  onDone: (id: string, failed: boolean, err?: string) => void;
}) {
  const p = useJobProgress(taskId, onDone);
  const pct = p.totalPages ? Math.min((p.completedPages / p.totalPages) * 100, 100) : 0;
  const shownPages = useCountUp(p.completedPages);
  const entries = Object.entries(p.files);

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">Processing documents</h2>
            <p className="text-sm text-muted-foreground">
              {p.totalFiles ? `${plural(p.totalFiles, 'file')} - ` : ''}
              {p.totalPages ? `${p.totalPages.toLocaleString()} pages` : 'Starting...'}
            </p>
          </div>
          <div className="text-right">
            <div className="font-semibold tabular">
              {p.eta == null
                ? 'Estimating...'
                : p.eta <= 0
                  ? 'Finishing up'
                  : `About ${formatDuration(p.eta)}`}
            </div>
            <div className="text-xs text-muted-foreground">
              {p.eta == null ? 'measuring throughput' : 'remaining'}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <Progress value={pct} />
          <div className="flex justify-between text-sm text-muted-foreground tabular">
            <span>
              {shownPages.toLocaleString()} of {p.totalPages.toLocaleString()} pages
            </span>
            <span>{Math.round(pct)}%</span>
          </div>
        </div>

        {entries.length > 0 && (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {entries.map(([name, status]) => {
              const done = status === 'done';
              // The backend sends "processing (3/11)", not a bare "processing".
              const processing = status.startsWith('processing');
              return (
                <div
                  key={name}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm',
                    processing ? 'bg-accent/60' : 'bg-muted/40',
                  )}
                >
                  {done ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" />
                  ) : processing ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Clock className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <Badge variant={done ? 'success' : processing ? 'primary' : 'outline'}>
                    {done ? 'Done' : processing ? status.replace('processing ', '') : 'Queued'}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DropZone({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
      toast.info('Only PDF files are supported.');
      return;
    }
    onFiles(files);
  };

  return (
    <button
      type="button"
      disabled={disabled}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) pick(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'flex w-full flex-col items-center gap-4 rounded-lg border-2 border-dashed border-border bg-card px-6 py-14 transition-colors',
        over && 'border-primary bg-accent/50',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-primary/60 hover:bg-accent/30',
      )}
    >
      <div className="flex size-14 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <UploadCloud className="size-6" />
      </div>
      <div className="space-y-1 text-center">
        <p className="font-medium">{over ? 'Drop to upload' : 'Drop PDFs here'}</p>
        <p className="text-sm text-muted-foreground">or click to browse</p>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".pdf"
        className="hidden"
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
    </button>
  );
}

export function UploadPage() {
  const navigate = useNavigate();
  const { data: folders = [] } = useFolders();
  const upload = useUpload();

  const [pending, setPending] = useState<File[]>([]);
  const [useGpu, setUseGpu] = useState(true);
  const [folderId, setFolderId] = useState('');
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);

  const start = () => {
    if (pending.length === 0) return;
    setFinished(null);
    upload.mutate(
      { files: pending, useGpu, folderId: folderId ? Number(folderId) : null },
      {
        onSuccess: (res) => {
          setActiveTask(res.task_id);
          setPending([]);
        },
      },
    );
  };

  const onDone = useCallback((taskId: string, failed: boolean, error?: string) => {
    setActiveTask(null);
    if (failed) {
      toast.error(error ?? 'Processing failed');
      return;
    }
    setFinished(taskId);
    toast.success('Processing complete.');
  }, []);

  const totalMb = pending.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024;

  return (
    <>
      <PageHeader
        title="Upload & process"
        description="Detect page orientation, flag uncertain pages, and produce searchable PDFs."
      />

      {activeTask ? (
        <ActiveJob taskId={activeTask} onDone={onDone} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            <DropZone onFiles={(f) => setPending((cur) => [...cur, ...f])} disabled={upload.isPending} />

            {pending.length > 0 && (
              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">
                      {plural(pending.length, 'file')} ready
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        {totalMb.toFixed(1)} MB
                      </span>
                    </h3>
                    <Button variant="ghost" size="sm" onClick={() => setPending([])}>
                      <X />
                      Clear
                    </Button>
                  </div>
                  <div className="max-h-96 space-y-1 overflow-y-auto">
                    {pending.map((f, i) => (
                      <div
                        key={`${f.name}:${f.size}:${i}`}
                        className="flex items-center gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm"
                      >
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular">
                          {(f.size / 1024 / 1024).toFixed(1)} MB
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${f.name}`}
                          onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))}
                        >
                          <X />
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-5">
            <Card>
              <CardContent className="space-y-4 p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Options
                </p>

                <label htmlFor="use-gpu" className="flex cursor-pointer items-start gap-3">
                  <input
                    id="use-gpu"
                    type="checkbox"
                    checked={useGpu}
                    onChange={(e) => setUseGpu(e.target.checked)}
                    className="mt-0.5 size-4 accent-[hsl(var(--primary))]"
                  />
                  <span className="space-y-0.5">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <Zap className="size-3.5 text-warning" />
                      GPU acceleration
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Much faster; falls back to CPU if unavailable
                    </span>
                  </span>
                </label>

                <div className="space-y-1.5">
                  <label htmlFor="folder-select" className="text-sm font-medium">
                    Save to folder
                  </label>
                  <select
                    id="folder-select"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm"
                  >
                    <option value="">Unfiled</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                </div>

                <Button
                  className="w-full"
                  disabled={pending.length === 0}
                  loading={upload.isPending}
                  onClick={start}
                >
                  {upload.isPending
                    ? 'Uploading...'
                    : `Process ${pending.length ? plural(pending.length, 'file') : 'files'}`}
                </Button>
              </CardContent>
            </Card>

            {finished && (
              <Card className="border-success/40 bg-success/5">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="size-4 text-success" />
                    Processing complete
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Check the pages the model was unsure about, or download the result.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => navigate(`/review/${finished}`)}>
                      Review flagged pages
                    </Button>
                    <Button size="sm" variant="secondary" asChild>
                      <a href={urls.download(finished)}>
                        <Download />
                        Download
                      </a>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </>
  );
}
