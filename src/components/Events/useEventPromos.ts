import { useMemo } from 'react';
import { eventPromosFrom } from '~/components/Events/event-promos';
import { NAV_BANNERS_STALE_TIME } from '~/providers/AppProvider';
import type { EventPromo } from '~/shared/constants/nav-banner.constants';
import { trpc } from '~/utils/trpc';

/** Seeded by the settings bootstrap on every page, so reading it costs no request. */
export function useEventPromos(): EventPromo[] {
  const { data } = trpc.event.getNavBanners.useQuery(undefined, {
    staleTime: NAV_BANNERS_STALE_TIME,
  });
  return useMemo(() => eventPromosFrom(data), [data]);
}
