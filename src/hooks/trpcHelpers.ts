import { QueryKey } from '@tanstack/react-query';
import produce from 'immer';
import { queryClient } from '~/utils/trpc';

export function updateQueries<TData = unknown>(queryKey: QueryKey, cb: (data: TData) => void) {
  queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
    produce(state, (old?: TData) => {
      if (!old) return;
      cb(old);
    })
  );
}
