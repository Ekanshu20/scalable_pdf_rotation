import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export const EmptyState = ({ icon: Icon, title, description, action, className }: EmptyStateProps) => (
  <div className={cn('flex flex-col items-center justify-center gap-3 px-6 py-14 text-center', className)}>
    <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon className="size-6" />
    </div>
    <div className="space-y-1">
      <p className="font-medium text-foreground">{title}</p>
      {description ? <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p> : null}
    </div>
    {action}
  </div>
);
