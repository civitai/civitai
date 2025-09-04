import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

const TosModal = dynamic(() => import('~/components/ToSModal/TosModal'), {
  ssr: false,
});

export function useToSUpdateModal() {
  const currentUser = useCurrentUser();
  const dialogStore = useDialogStore();
  const shownForVersion = useRef<Date | null>(null);

  const queryUtils = trpc.useUtils();
  const { data: tosUpdate } = trpc.content.checkTosUpdate.useQuery(undefined, {
    enabled: !!currentUser,
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
          onAccepted: async () => {
            await currentUser.refresh();
            // Use queryUtils to update the query data from trpc.content.checkTosUpdate
            queryUtils.content.checkTosUpdate.setData(undefined, (old) =>
              old
                ? {
                    ...old,
                    hasUpdate: false,
                    lastmod: new Date(),
                    userLastSeen: new Date(),
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
