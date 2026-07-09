import { keepPreviousData } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import produce from 'immer';
import { queryClient } from '~/utils/trpc';

/**
 * React Query v5 removed the `keepPreviousData: boolean` option in favor of
 * `placeholderData: keepPreviousData` (a function). Re-exported here so callsites
 * have a single import source for the migration.
 */
export { keepPreviousData };

/**
 * Translates a caller-supplied options bag that still uses the legacy
 * `keepPreviousData?: boolean` flag into the v5 `placeholderData` function form,
 * passing every other option through untouched. Use when forwarding wrapper
 * options into a tRPC query hook, e.g. `useInfiniteQuery(input, withPlaceholderData(options))`.
 */
export function withPlaceholderData<T extends { keepPreviousData?: boolean }>(
  options?: T
): Omit<T, 'keepPreviousData'> & { placeholderData?: typeof keepPreviousData } {
  const { keepPreviousData: keep, ...rest } = options ?? ({} as T);
  return {
    ...(rest as Omit<T, 'keepPreviousData'>),
    ...(keep ? { placeholderData: keepPreviousData } : {}),
  };
}

export function updateQueries<TData = unknown>(queryKey: QueryKey, cb: (data: TData) => void) {
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: TData) => {
      if (!old) return;
      cb(old);
    })
  );
}
