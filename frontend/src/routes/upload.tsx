import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle2, Clock, Download, FileText, FileWarning, Info, Loader2,
  RefreshCw, UploadCloud, X, Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Progress } from '@/components/ui/progress';
import { urls } from '@/lib/api';
import { keys, useFolders } from '@/lib/queries';
import { uploadManager, useUploadManager, type UploadItem } from '@/lib/upload-manager';
import { cn, formatBytes, formatDuration, plural } from '@/lib/utils';
import { useCountUp } from '@/hooks/use-count-up';
import { useJobProgress } from '@/hooks/use-job-progress';

// ===== Processing (after upload) =====

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
              {p.eta == null ? 'Estimating...' : p.eta <= 0 ? 'Finishing up' : `About ${formatDuration(p.eta)}`}
            </div>
            <div className="text-xs text-muted-foreground">{p.eta == null ? 'measuring throughput' : 'remaining'}</div>
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

// ===== Upload in progress =====

function UploadRow({ item }: { item: UploadItem }) {
  const pct = item.size ? (item.sent / item.size) * 100 : 0;
  const icon = {
    queued: <Clock className="size-4 shrink-0 text-muted-foreground" />,
    uploading: <Loader2 className="size-4 shrink-0 animate-spin text-primary" />,
    retrying: <RefreshCw className="size-4 shrink-0 animate-spin text-warning" />,
    done: <CheckCircle2 className="size-4 shrink-0 text-success" />,
    failed: <AlertTriangle className="size-4 shrink-0 text-destructive" />,
    invalid: <FileWarning className="size-4 shrink-0 text-destructive" />,
  }[item.status];

  return (
    <div
      className={cn(
        'space-y-1.5 rounded-md px-3 py-2 text-sm',
        item.status === 'uploading' || item.status === 'retrying' ? 'bg-accent/50' : 'bg-muted/40',
      )}
    >
      <div className="flex items-center gap-3">
        {icon}
        <span className="min-w-0 flex-1 truncate" title={item.name}>
          {item.name}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground tabular sm:inline">
          {item.status === 'done' ? formatBytes(item.size) : `${formatBytes(item.sent)} / ${formatBytes(item.size)}`}
        </span>
        {item.status === 'queued' && <Badge variant="outline">Queued</Badge>}
        {item.status === 'uploading' && <Badge variant="primary">{Math.floor(pct)}%</Badge>}
        {item.status === 'retrying' && <Badge variant="warning">Reconnecting ({item.attempt})</Badge>}
        {item.status === 'done' && <Badge variant="success">Uploaded</Badge>}
        {(item.status === 'failed' || item.status === 'invalid') && (
          <Badge variant="destructive">{item.status === 'invalid' ? 'Not a PDF' : 'Failed'}</Badge>
        )}
      </div>
      {(item.status === 'uploading' || item.status === 'retrying') && (
        <Progress
          value={pct}
          className="h-1"
          indicatorClassName={item.status === 'retrying' ? 'bg-warning' : undefined}
        />
      )}
      {item.error && (item.status === 'failed' || item.status === 'invalid') && (
        <p className="pl-7 text-xs text-destructive">{item.error}</p>
      )}
    </div>
  );
}

function UploadProgressCard() {
  const s = useUploadManager();
  const { confirm, dialog } = useConfirm();
  const pct = s.totalBytes ? (s.sentBytes / s.totalBytes) * 100 : 0;
  const done = s.items.filter((i) => i.status === 'done').length;
  const failed = s.items.filter((i) => i.status === 'failed').length;
  const invalid = s.items.filter((i) => i.status === 'invalid').length;
  const retrying = s.items.some((i) => i.status === 'retrying');
  const committing = s.phase === 'committing';
  const attention = s.phase === 'attention';

  // Failures and in-flight files first: those are what the user needs to see.
  const order: Record<UploadItem['status'], number> = { failed: 0, invalid: 1, retrying: 2, uploading: 3, queued: 4, done: 5 };
  const items = [...s.items].sort((a, b) => order[a.status] - order[b.status]);

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              attention ? 'bg-destructive/10 text-destructive' : 'bg-accent text-accent-foreground',
            )}
          >
            {attention ? <AlertTriangle className="size-5" /> : <UploadCloud className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">
              {committing
                ? 'Starting processing...'
                : attention
                  ? failed
                    ? `${plural(failed, 'file')} couldn't be uploaded`
                    : 'Upload finished with a problem'
                  : `Uploading ${Math.min(done + 1, s.items.length)} of ${plural(s.items.length, 'file')}`}
            </h2>
            <p className="text-sm text-muted-foreground tabular">
              {formatBytes(s.sentBytes)} of {formatBytes(s.totalBytes)}
              {s.bytesPerSecond != null && s.phase === 'uploading' ? ` - ${formatBytes(Math.max(s.bytesPerSecond, 0))}/s` : ''}
            </p>
          </div>
          {s.phase === 'uploading' && (
            <div className="text-right">
              <div className="font-semibold tabular">
                {retrying ? 'Reconnecting...' : s.etaSeconds == null ? 'Measuring speed...' : `About ${formatDuration(s.etaSeconds)}`}
              </div>
              <div className="text-xs text-muted-foreground">{s.etaSeconds == null || retrying ? '' : 'remaining'}</div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Progress value={pct} indicatorClassName={attention ? 'bg-destructive' : undefined} />
          <div className="flex justify-between text-sm text-muted-foreground tabular">
            <span>
              {done} of {s.items.length} files uploaded
              {invalid ? ` - ${invalid} skipped` : ''}
            </span>
            <span>{Math.floor(pct)}%</span>
          </div>
        </div>

        {s.phase === 'uploading' && (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <Info className="mt-px size-3.5 shrink-0" />
            Keep this tab open until the upload finishes. You can switch pages; the upload continues. If the connection
            drops, it resumes automatically.
          </p>
        )}

        {attention && (
          <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <p>
              {s.error ??
                `The connection kept failing for ${plural(failed, 'file')}. Uploaded data is kept, so retrying continues where each file stopped.`}
            </p>
            <div className="flex flex-wrap gap-2">
              {failed > 0 && (
                <Button size="sm" onClick={() => void uploadManager.retryFailed()}>
                  <RefreshCw />
                  Retry {plural(failed, 'file')}
                </Button>
              )}
              {done > 0 && (
                <Button size="sm" variant="secondary" onClick={() => void uploadManager.continueWithoutFailed()}>
                  {failed > 0 ? `Process the ${plural(done, 'uploaded file')}` : 'Try starting processing again'}
                </Button>
              )}
            </div>
          </div>
        )}

        <div className="max-h-96 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <UploadRow key={item.key} item={item} />
          ))}
        </div>

        {!committing && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                confirm({
                  title: 'Cancel upload',
                  description: 'Files uploaded so far will be discarded.',
                  confirmLabel: 'Cancel upload',
                  destructive: true,
                  onConfirm: () => uploadManager.cancel(),
                })
              }
            >
              <X />
              Cancel upload
            </Button>
          </div>
        )}
        {dialog}
      </CardContent>
    </Card>
  );
}

// ===== Picking files =====

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
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
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'flex w-full flex-col items-center gap-4 rounded-lg border-2 border-dashed border-border bg-card px-6 py-14 transition-colors hover:border-primary/60 hover:bg-accent/30',
        over && 'border-primary bg-accent/50',
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
  const qc = useQueryClient();
  const { data: folders = [] } = useFolders();
  const upload = useUploadManager();

  const [pending, setPending] = useState<File[]>([]);
  const [useGpu, setUseGpu] = useState(true);
  const [folderId, setFolderId] = useState('');

  const addFiles = (incoming: File[]) => {
    // One upload can't hold two files with the same name (they'd overwrite each other's output).
    const names = new Set(pending.map((f) => f.name));
    const fresh = incoming.filter((f) => !names.has(f.name) && names.add(f.name));
    const skipped = incoming.length - fresh.length;
    if (skipped) toast.info(`Skipped ${plural(skipped, 'file')} with a name already in the list.`);
    if (fresh.length) setPending([...pending, ...fresh]);
  };

  const start = () => {
    if (pending.length === 0) return;
    const files = pending;
    setPending([]);
    void uploadManager.start(files, { useGpu, folderId: folderId ? Number(folderId) : null });
  };

  const onDone = useCallback(
    (taskId: string, failed: boolean, error?: string) => {
      uploadManager.finishProcessing(taskId, failed);
      qc.invalidateQueries({ queryKey: keys.history });
      qc.invalidateQueries({ queryKey: keys.folders });
      if (failed) toast.error(error ?? 'Processing failed');
      else toast.success('Processing complete.');
    },
    [qc],
  );

  const totalBytes = pending.reduce((sum, f) => sum + f.size, 0);
  const uploading = upload.phase === 'uploading' || upload.phase === 'committing' || upload.phase === 'attention';

  return (
    <>
      <PageHeader
        title="Upload & process"
        description="Detect page orientation, flag uncertain pages, and produce searchable PDFs."
      />

      {upload.phase === 'processing' && upload.taskId ? (
        <ActiveJob taskId={upload.taskId} onDone={onDone} />
      ) : uploading ? (
        <UploadProgressCard />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
          <div className="space-y-5">
            {upload.error && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span className="flex-1">{upload.error}</span>
                <button type="button" aria-label="Dismiss" onClick={() => uploadManager.dismiss()}>
                  <X className="size-4" />
                </button>
              </div>
            )}

            <DropZone onFiles={addFiles} />

            {pending.length > 0 && (
              <Card>
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="font-medium">
                      {plural(pending.length, 'file')} ready
                      <span className="ml-2 text-sm font-normal text-muted-foreground">{formatBytes(totalBytes)}</span>
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
                        <span className="shrink-0 text-xs text-muted-foreground tabular">{formatBytes(f.size)}</span>
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
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Options</p>

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

                <Button className="w-full" disabled={pending.length === 0} onClick={start}>
                  {`Upload & process ${pending.length ? plural(pending.length, 'file') : 'files'}`}
                </Button>
              </CardContent>
            </Card>

            {upload.phase === 'finished' && upload.finishedTaskId && (
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
                    <Button size="sm" onClick={() => navigate(`/review/${upload.finishedTaskId}`)}>
                      Review flagged pages
                    </Button>
                    <Button size="sm" variant="secondary" asChild>
                      <a href={urls.download(upload.finishedTaskId)}>
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
