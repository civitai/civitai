import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

const TosModal = dynamic(() => import('~/components/ToSModal/TosModal'), {
  ssr: false,
});

export function useToSUpdateModal() {
  const currentUser = useCurrentUser();
  const shownForVersion = useRef<Date | null>(null);

  const queryUtils = trpc.useUtils();
  // `content.checkTosUpdate` is SSR-seeded in AppProvider (an ancestor) as
  // `initialData`. ToS lastmod only changes on a content deploy — never
  // mid-session — so the per-load SSR snapshot is exactly as fresh as a live
  // fetch. `staleTime: Infinity` keeps this observer from refetching the primed
  // cache on mount, removing the per-bootstrap round-trip (the uncached
  // server-side `readFile`). The accept flow's `setData` still patches
  // `hasUpdate=false` regardless of staleTime.
  const { data: tosUpdate } = trpc.content.checkTosUpdate.useQuery(undefined, {
    enabled: !!currentUser,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  useEffect(() => {
    if (
      currentUser &&
      tosUpdate?.hasUpdate &&
      tosUpdate.lastmod &&
      (!shownForVersion.current ||
        shownForVersion.current.getTime() !== tosUpdate.lastmod.getTime())
    ) {
      shownForVersion.current = tosUpdate.lastmod;

      dialogStore.trigger({
        component: TosModal,
        props: {
          slug: 'tos',
          fieldKey: tosUpdate.tosFieldKey || ('tosLastSeenDate' as const),
          showBackButton: false,
          onAccepted: async () => {
            await currentUser.refresh();
            // Use queryUtils to update the query data from trpc.content.checkTosUpdate
            queryUtils.content.checkTosUpdate.setData(undefined, (old) =>
              old
                ? {
                    ...old,
                    hasUpdate: false,
                    lastmod: tosUpdate.lastmod,
                  }
                : old
            );
          },
        },
      });
    }
  }, [currentUser, tosUpdate]);

  return { tosUpdate };
}
