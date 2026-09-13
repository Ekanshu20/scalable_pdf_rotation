import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, Download, FileText, FolderOpen, Inbox, Merge, Search, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { urls } from '@/lib/api';
import { useDeleteFiles, useFolderFiles, useFolders, useMergeFolder } from '@/lib/queries';
import { cn, formatDate, plural } from '@/lib/utils';

export function FolderDetailPage() {
  const { folderId = '' } = useParams();
  const scope = folderId === 'unfiled' ? 'unfiled' : Number(folderId);
  const isUnfiled = scope === 'unfiled';

  const { data: folders = [] } = useFolders();
  const { data, isLoading, isError } = useFolderFiles(scope);
  const deleteFiles = useDeleteFiles(scope);
  // Hooks can't be conditional; for Unfiled the merge button is never rendered.
  const merge = useMergeFolder(isUnfiled ? -1 : (scope as number));
  const { confirm, dialog } = useConfirm();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number[]>([]);

  const folderName = isUnfiled
    ? 'Unfiled uploads'
    : (folders.find((f) => f.id === scope)?.name ?? 'Folder');

  const files = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = data?.files ?? [];
    return q ? all.filter((f) => f.filename.toLowerCase().includes(q)) : all;
  }, [data, query]);

  const liveSelected = selected.filter((id) => files.some((f) => f.id === id));
  const allSelected = files.length > 0 && liveSelected.length === files.length;

  const askDelete = (ids: number[], label: string) =>
    confirm({
      title: ids.length === 1 ? 'Delete file' : `Delete ${plural(ids.length, 'file')}`,
      description: `${label} will be permanently deleted.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () =>
        deleteFiles.mutateAsync(ids).then(() => setSelected((cur) => cur.filter((x) => !ids.includes(x)))),
    });

  if (!isUnfiled && Number.isNaN(scope)) {
    return <EmptyState icon={FolderOpen} title="Folder not found" />;
  }

  return (
    <>
      <PageHeader
        back={
          <Link
            to="/folders"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            All folders
          </Link>
        }
        title={folderName}
        description={
          isUnfiled
            ? 'PDFs uploaded without picking a folder.'
            : data
              ? plural(data.files.length, 'file')
              : 'Files in this folder.'
        }
        actions={
          !isUnfiled && (
            <>
              <Button variant="secondary" asChild>
                <a href={urls.folderZip(scope as number)}>
                  <Download />
                  Download ZIP
                </a>
              </Button>
              <Button variant="secondary" loading={merge.isPending} onClick={() => merge.mutate()}>
                <Merge />
                Merge PDFs
              </Button>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="file-search"
            className="pl-8"
            placeholder="Search files..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {files.length > 0 && (
          <label htmlFor="select-all-files" className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              id="select-all-files"
              checked={allSelected ? true : liveSelected.length ? 'indeterminate' : false}
              onCheckedChange={(v) => setSelected(v === true ? files.map((f) => f.id) : [])}
            />
            {liveSelected.length ? `${liveSelected.length} selected` : 'Select all'}
          </label>
        )}
        <div className="flex-1" />
        {liveSelected.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => askDelete(liveSelected, plural(liveSelected.length, 'selected file'))}
          >
            <Trash2 />
            Delete {liveSelected.length}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState icon={FolderOpen} title="Couldn't load this folder" description="It may have been deleted." />
      ) : files.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card">
          <EmptyState
            icon={query ? Search : isUnfiled ? Inbox : FolderOpen}
            title={query ? 'No matching files' : isUnfiled ? 'No unfiled uploads' : 'This folder is empty'}
            description={
              query
                ? `Nothing matches "${query}".`
                : isUnfiled
                  ? 'PDFs uploaded without picking a folder will appear here.'
                  : 'Upload PDFs into this folder, or move a job here from History.'
            }
          />
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {files.map((f) => {
            const checked = liveSelected.includes(f.id);
            return (
              <div
                key={f.id}
                className={cn('flex items-center gap-3 px-4 py-3 transition-colors', checked ? 'bg-accent/40' : 'hover:bg-muted/40')}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) =>
                    setSelected((cur) => (v === true ? [...cur, f.id] : cur.filter((x) => x !== f.id)))
                  }
                  aria-label={`Select ${f.filename}`}
                />
                <FileText className={cn('size-5 shrink-0', f.available ? 'text-primary' : 'text-muted-foreground')} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={f.filename}>
                    {f.filename}
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDate(f.created_at)}</p>
                </div>
                {f.available ? (
                  <Button variant="secondary" size="sm" asChild>
                    <a href={urls.file(f.id)}>
                      <Download />
                      <span className="hidden sm:inline">Download</span>
                    </a>
                  </Button>
                ) : (
                  <Badge variant="outline">Expired</Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${f.filename}`}
                  onClick={() => askDelete([f.id], `"${f.filename}"`)}
                >
                  <Trash2 />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {dialog}
    </>
  );
}
