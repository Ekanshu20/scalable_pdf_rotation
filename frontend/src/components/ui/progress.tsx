import { cn } from '@/lib/utils';

interface ProgressProps {
  value: number;
  className?: string;
  indicatorClassName?: string;
}

export const Progress = ({ value, className, indicatorClassName }: ProgressProps) => (
  <div
    role="progressbar"
    aria-valuenow={Math.round(value)}
    aria-valuemin={0}
    aria-valuemax={100}
    className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
  >
    <div
      className={cn('h-full rounded-full bg-primary transition-[width] duration-500 ease-out', indicatorClassName)}
      style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
    />
  </div>
);
