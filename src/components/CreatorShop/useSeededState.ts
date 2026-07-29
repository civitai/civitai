import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useRef, useState } from 'react';

/**
 * Seeds local state from a query result that may still be loading on first
 * render. Initializes from `source` immediately when it's already resolved, and
 * re-seeds exactly once — the first time `source` resolves — so edits the user
 * makes afterward aren't clobbered by later refetches.
 */
export function useSeededState<TSource, TState>(
  source: TSource | undefined | null,
  select: (source: TSource | undefined | null) => TState
): [TState, Dispatch<SetStateAction<TState>>] {
  const selectRef = useRef(select);
  selectRef.current = select;

  const [state, setState] = useState<TState>(() => selectRef.current(source));
  const seededRef = useRef(source != null);

  useEffect(() => {
    if (source == null || seededRef.current) return;
    seededRef.current = true;
    setState(selectRef.current(source));
  }, [source]);

  return [state, setState];
}
