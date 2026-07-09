import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';

export const useQueryHiddenPreferences = () => {
  const { data, ...rest } = trpc.hiddenPreferences.getHidden.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  // Per-field coalesce. Rolling deploys can briefly serve responses that
  // pre-date the `hiddenModel3Ds` field (and SSR-hydrated caches from an
  // older render carry the same risk), so a missing top-level key would
  // crash the consumer on `data.hiddenModel3Ds.map(...)`. Defaulting at the
  // field level — rather than only when `data` is entirely undefined — keeps
  // the provider resilient to any older-shape response.
  const _data = useMemo(
    () => ({
      hiddenModels: data?.hiddenModels ?? [],
      hiddenModel3Ds: data?.hiddenModel3Ds ?? [],
      hiddenImages: data?.hiddenImages ?? [],
      hiddenTags: data?.hiddenTags ?? [],
      hiddenUsers: data?.hiddenUsers ?? [],
      blockedUsers: data?.blockedUsers ?? [],
      blockedByUsers: data?.blockedByUsers ?? [],
    }),
    [data]
  );
  return { data: _data, ...rest };
};

export const useHiddenPreferencesData = () => {
  const { data } = useQueryHiddenPreferences();
  return data;
};
