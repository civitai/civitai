import { useMemo } from 'react';
import { expandHiddenPreferences } from '~/shared/hidden-preferences/compact';
import { trpc } from '~/utils/trpc';

export const useQueryHiddenPreferences = () => {
  const { data, ...rest } = trpc.hiddenPreferences.getHidden.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  // `getHidden` may return the COMPACT wire shape (id-only arrays, flag-gated by
  // `hiddenPrefsCompact`) or the legacy object shape. `expandHiddenPreferences`
  // normalizes BOTH — plus undefined and older-field-missing responses — into
  // the legacy `HiddenPreferenceTypes` shape so downstream consumers are
  // untouched. Per-field coalescing (every key defaults to `[]`) is preserved:
  // rolling deploys / stale SSR hydration can serve a response that predates a
  // field (e.g. `hiddenModel3Ds`), which would otherwise crash a consumer on
  // `.map(...)`. This makes THIS bundle (and any later one) robust to either
  // shape — but a PRE-PR bundle has no expander and breaks on the compact shape,
  // so the `hiddenPrefsCompact` Flipt ramp must wait until this bundle is
  // deployed everywhere (see `~/shared/hidden-preferences/compact`).
  const _data = useMemo(() => expandHiddenPreferences(data), [data]);
  return { data: _data, ...rest };
};

export const useHiddenPreferencesData = () => {
  const { data } = useQueryHiddenPreferences();
  return data;
};
