import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Kbd = ({ className, ...props }: HTMLAttributes<HTMLElement>) => (
  <kbd
    className={cn(
      'inline-flex h-5 min-w-5 items-center justify-center rounded border border-current/20 bg-black/5 px-1 font-mono text-[10px] font-medium opacity-80',
      className,
    )}
    {...props}
  />
);
