import { useEffect, useRef } from 'react';

/**
 * Resets the form to `values` each time they change and returns them as the baseline a save is
 * diffed against, so the two never diverge. A baseline taken only on the first seed goes stale
 * once an invalidate refetches the query while the editor is mounted.
 */
export function useResetBaseline<T>(values: T | undefined, reset: (values: T) => void) {
  const baseline = useRef<T>();
  useEffect(() => {
    if (!values) return;
    baseline.current = values;
    reset(values);
  }, [values, reset]);
  return baseline;
}
