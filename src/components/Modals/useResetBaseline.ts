import { useEffect, useRef } from 'react';

/**
 * Resets the form to `values` each time they change and returns them as the baseline a save is
 * diffed against. With `staleTime: Infinity` an edit modal opens on cached data and the mount
 * refetch reseeds it, so a baseline taken only on the first seed would be stale.
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
