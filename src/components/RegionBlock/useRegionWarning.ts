import { getRegionBlockDate } from '~/server/utils/region-blocking';
import { useEffect } from 'react';
import { trpc } from '~/utils/trpc';
import { useIsRegionBlocked } from '~/hooks/useIsRegionBlocked';
import { dialogStore } from '~/components/Dialog/dialogStore';
import dynamic from 'next/dynamic';
import { useAppContext } from '~/providers/AppProvider';

export function useRegionWarning() {
  const { region } = useAppContext();
  const { isPendingBlock } = useIsRegionBlocked();

  // Generate content key based on region
  const contentKey = region.countryCode || 'unknown';
  const storageKey = `region-warning-dismissed-${contentKey}`;

  // Fetch markdown content from Redis
  const { data } = trpc.content.getMarkdown.useQuery(
    { key: contentKey as string },
    { enabled: isPendingBlock }
  );

  useEffect(() => {
    if (!data) return;

    const blockDate = getRegionBlockDate(region);
    if (!blockDate || blockDate < new Date()) return;

    const isDismissed = localStorage.getItem(storageKey) === 'true';
    if (isDismissed) return;

    dialogStore.trigger({
      id: 'region-warning',
      component: dynamic(() => import('~/components/RegionBlock/RegionWarningModal')),
      props: { ...data, storageKey },
    });
  }, [storageKey, data]);
}
