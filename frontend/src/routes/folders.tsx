import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Folder, FolderPlus, Inbox, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useConfirm } from '@/components/ui/confirm-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { urls } from '@/lib/api';
import { useCreateFolder, useDeleteFolders, useFolders, useRenameFolder } from '@/lib/queries';
import type { Folder as FolderT } from '@/lib/types';
import { cn, formatDate, plural } from '@/lib/utils';

/** One dialog for both create and rename — they are the same form. */
function FolderNameDialog({
  open, onOpenChange, folder,
}: { open: boolean; onOpenChange: (o: boolean) => void; folder: FolderT | null }) {
  const create = useCreateFolder();
  const rename = useRenameFolder();
  const [name, setName] = useState('');
  const busy = create.isPending || rename.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const done = { onSuccess: () => onOpenChange(false) };
    if (folder) rename.mutate({ id: folder.id, name: trimmed }, done);
    else create.mutate(trimmed, done);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) setName(folder?.name ?? '');
        onOpenChange(o);
      }}
    >
      <DialogContent onOpenAutoFocus={() => setName(folder?.name ?? '')}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{folder ? 'Rename folder' : 'New folder'}</DialogTitle>
            <DialogDescription>
              {folder ? 'Choose a new name for this folder.' : 'Folders keep related documents together.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            id="folder-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Purchase orders - September"
            maxLength={120}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {folder ? 'Rename' : 'Create folder'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FolderCard({
  folder, selected, onToggle, onOpen, onRename, onDelete,
}: {
  folder: FolderT;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn(
        'group flex cursor-pointer flex-col gap-3 rounded-lg border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
        selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-primary/40',
      )}
    >
      <div className="flex items-center gap-3">
        <Checkbox
          checked={selected}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={onToggle}
          aria-label={`Select ${folder.name}`}
        />
        <div className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Folder className="size-5" />
        </div>
        <div className="flex-1" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Folder actions"
              className="opacity-60 group-hover:opacity-100"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onRename}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <a href={urls.folderZip(folder.id)}>
                <Download />
                Download ZIP
              </a>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={onDelete}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <h3 className="line-clamp-2 min-h-[2.5rem] break-words font-medium leading-5" title={folder.name}>
        {folder.name}
      </h3>
      <div className="flex items-center justify-between text-xs">
        <Badge variant="primary">{plural(folder.file_count, 'file')}</Badge>
        <span className="text-muted-foreground">{formatDate(folder.created_at)}</span>
      </div>
    </div>
  );
}

const FolderSkeleton = () => (
  <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
    <div className="flex items-center gap-3">
      <Skeleton className="size-4" />
      <Skeleton className="size-9" />
    </div>
    <div className="space-y-2">
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="h-3 w-1/2" />
    </div>
    <div className="flex justify-between">
      <Skeleton className="h-4 w-14 rounded-full" />
      <Skeleton className="h-3 w-10" />
    </div>
  </div>
);

export function FoldersPage() {
  const navigate = useNavigate();
  const { data: folders = [], isLoading } = useFolders();
  const deleteFolders = useDeleteFolders();
  const { confirm, dialog } = useConfirm();

  const [selected, setSelected] = useState<number[]>([]);
  const [nameDialog, setNameDialog] = useState<{ open: boolean; folder: FolderT | null }>({
    open: false,
    folder: null,
  });

  // Selection can outlive the folders it points at (e.g. after a delete), so
  // only count ids that still exist — this is what kept "Delete 19" on screen.
  const liveSelected = selected.filter((id) => folders.some((f) => f.id === id));
  const allSelected = folders.length > 0 && liveSelected.length === folders.length;
  const someSelected = liveSelected.length > 0 && !allSelected;
  const totalDocs = folders.reduce((n, f) => n + f.file_count, 0);

  const toggle = (id: number) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const askDelete = (ids: number[], label: string) =>
    confirm({
      title: ids.length === 1 ? 'Delete folder' : `Delete ${plural(ids.length, 'folder')}`,
      description: `${label} and the file records inside will be deleted. This cannot be undone.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () =>
        deleteFolders.mutateAsync(ids).then(() => setSelected((cur) => cur.filter((x) => !ids.includes(x)))),
    });

  const openCreate = () => setNameDialog({ open: true, folder: null });

  return (
    <>
      <PageHeader
        title="Folders"
        description={isLoading ? 'Loading...' : `${plural(folders.length, 'folder')} - ${plural(totalDocs, 'document')}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/folders/unfiled')}>
              <Inbox />
              Unfiled uploads
            </Button>
            <Button onClick={openCreate}>
              <FolderPlus />
              New folder
            </Button>
          </>
        }
      />

      {folders.length > 0 && (
        <div className="mb-4 flex min-h-9 flex-wrap items-center gap-3">
          <label htmlFor="select-all-folders" className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              id="select-all-folders"
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={(v) => setSelected(v === true ? folders.map((f) => f.id) : [])}
            />
            {liveSelected.length > 0 ? `${liveSelected.length} selected` : 'Select all'}
          </label>
          <div className="flex-1" />
          {liveSelected.length > 0 && (
            <>
              <Button variant="secondary" size="sm" asChild>
                <a href={urls.bulkFolders(liveSelected)}>
                  <Download />
                  Download {liveSelected.length}
                </a>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => askDelete(liveSelected, plural(liveSelected.length, 'folder'))}
              >
                <Trash2 />
                Delete {liveSelected.length}
              </Button>
            </>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          {Array.from({ length: 8 }, (_, i) => (
            <FolderSkeleton key={i} />
          ))}
        </div>
      ) : folders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card">
          <EmptyState
            icon={FolderPlus}
            title="No folders yet"
            description="Folders keep related documents together. Uploads without one land in Unfiled."
            action={
              <Button onClick={openCreate}>
                <FolderPlus />
                New folder
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          {folders.map((f) => (
            <FolderCard
              key={f.id}
              folder={f}
              selected={liveSelected.includes(f.id)}
              onToggle={() => toggle(f.id)}
              onOpen={() => navigate(`/folders/${f.id}`)}
              onRename={() => setNameDialog({ open: true, folder: f })}
              onDelete={() => askDelete([f.id], `"${f.name}"`)}
            />
          ))}
          <button
            type="button"
            onClick={openCreate}
            className="flex min-h-[9.5rem] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/30 hover:text-foreground"
          >
            <FolderPlus className="size-6" />
            New folder
          </button>
        </div>
      )}

      <FolderNameDialog
        open={nameDialog.open}
        folder={nameDialog.folder}
        onOpenChange={(open) => setNameDialog((s) => ({ ...s, open }))}
      />
      {dialog}
    </>
  );
}
