import { isEqual } from 'lodash-es';
import { useCallback, useState } from 'react';

export type UseStagedFiltersArgs<T extends object> = {
  // Currently-committed filters (Zustand store, URL params, or local state).
  committed: T;
  // Commits pending filters to the source. Called on Apply.
  onApply: (next: T) => void;
  // Optional. Commits an empty/reset state to the source. Called on Clear.
  onClear?: () => void;
};

export type UseStagedFiltersResult<T extends object> = {
  opened: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  pending: T;
  setPending: React.Dispatch<React.SetStateAction<T>>;
  // Shallow-merges a partial patch into the pending state. Matches the shape
  // of the per-dropdown `handleChange` callbacks the migration replaces.
  patchPending: (patch: Partial<T>) => void;
  // Pending while open, committed while closed — gives existing chip reads +
  // indicator badge a single source of truth that auto-shows the preview
  // count while the user is editing.
  mergedFilters: T;
  isDirty: boolean;
  apply: () => void;
  reset: () => void;
  clearAndClose: () => void;
};

/**
 * Stages filter edits in local state until the user hits Apply. Without
 * staging, every chip toggle fires a feed request and rapid filter churn
 * stacks heavy-image bulkhead slots server-side (see request-bulkhead.ts +
 * heavyProcedure in src/server/trpc.ts), producing TOO_MANY_REQUESTS for the
 * user and surrounding traffic. Used by feed filter dropdowns (images,
 * models, articles, bounties, posts, etc.) so one user intent → one fetch.
 */
export function useStagedFilters<T extends object>({
  committed,
  onApply,
  onClear,
}: UseStagedFiltersArgs<T>): UseStagedFiltersResult<T> {
  const [opened, setOpened] = useState(false);
  const [pending, setPending] = useState<T>(committed);

  const isDirty = !isEqual(pending, committed);
  const mergedFilters = opened ? pending : committed;

  const open = useCallback(() => {
    setPending(committed);
    setOpened(true);
  }, [committed]);

  const close = useCallback(() => {
    // Discard pending on close — Apply is the only commit path.
    setPending(committed);
    setOpened(false);
  }, [committed]);

  const toggle = useCallback(() => {
    setOpened((wasOpen) => {
      setPending(committed);
      return !wasOpen;
    });
  }, [committed]);

  const patchPending = useCallback((patch: Partial<T>) => {
    setPending((prev) => ({ ...prev, ...patch }));
  }, []);

  const apply = useCallback(() => {
    onApply(pending);
    setOpened(false);
  }, [onApply, pending]);

  const reset = useCallback(() => {
    setPending(committed);
  }, [committed]);

  const clearAndClose = useCallback(() => {
    onClear?.();
    setOpened(false);
  }, [onClear]);

  return {
    opened,
    open,
    close,
    toggle,
    pending,
    setPending,
    patchPending,
    mergedFilters,
    isDirty,
    apply,
    reset,
    clearAndClose,
  };
}
