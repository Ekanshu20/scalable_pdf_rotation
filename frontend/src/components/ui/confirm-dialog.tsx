import { useState, type ReactNode } from 'react';
import { Button } from './button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from './dialog';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<unknown>;
}

/**
 * Replaces window.confirm. Destructive actions still confirm - just not with
 * browser chrome (see CLAUDE.md).
 */
export function ConfirmDialog({
  open, onOpenChange, title, description,
  confirmLabel = 'Confirm', destructive, onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Mutations report their own errors via toast; keep the dialog open so
      // the user can retry or cancel.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription asChild><div>{description}</div></DialogDescription> : null}
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={run} loading={busy}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ConfirmRequest = Omit<ConfirmDialogProps, 'open' | 'onOpenChange'>;

/** Lets a page drive one shared ConfirmDialog instance instead of wiring state per action. */
export function useConfirm() {
  const [state, setState] = useState<ConfirmRequest | null>(null);
  const dialog = (
    <ConfirmDialog
      open={state !== null}
      onOpenChange={(o) => !o && setState(null)}
      title={state?.title ?? ''}
      description={state?.description}
      confirmLabel={state?.confirmLabel}
      destructive={state?.destructive}
      onConfirm={() => state?.onConfirm()}
    />
  );
  return { confirm: (req: ConfirmRequest) => setState(req), dialog };
}
