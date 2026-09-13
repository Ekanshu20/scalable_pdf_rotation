import { useEffect, useRef } from 'react';

type Handlers = Record<string, (e: KeyboardEvent) => void>;

/**
 * Single-key shortcuts. Ignored while typing in a field and when a modifier is
 * held, so they never swallow Ctrl+C or a page number being entered.
 */
export function useHotkeys(handlers: Handlers, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      // Radix dialogs are open: let them own the keyboard.
      if (document.querySelector('[role="dialog"]')) return;
      const fn = ref.current[e.key] ?? ref.current[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
