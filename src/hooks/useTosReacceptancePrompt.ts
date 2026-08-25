import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useAppContext } from '~/providers/AppProvider';
import { TOS_REACCEPTANCE_SECTION } from '~/server/common/tos-reacceptance';

const TosModal = dynamic(() => import('~/components/ToSModal/TosModal'), { ssr: false });

/**
 * Opens the ToS at the section a struck user broke, at the moment a mute blocks them from acting.
 *
 * The alternative was gating the whole site on re-acceptance via the onboarding wizard, which turns a
 * mute — today: cannot post, can still browse — into a lockout. This asks only when they try to do the
 * thing they are blocked from.
 *
 * One subscription on the shared `MutationCache` rather than a handler per call site: every muted write
 * in the app is refused by the same tRPC guard (`isMuted`), so one place catches all ~33 routers'
 * mutations. Note this covers tRPC mutations only — generation is gated separately by prompt auditing,
 * and REST endpoints refuse on their own.
 */
export function useTosReacceptancePrompt() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  // Same SSR-seeded metadata the update-modal uses: which ToS this domain serves, which settings
  // fields record acceptance, and the content hash to store.
  const { tosMeta } = useAppContext();
  const acceptTos = trpc.strike.acceptTosAfterMute.useMutation();

  useEffect(() => {
    if (!currentUser || !tosMeta) return;

    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;

      const data = (event.action.error as { data?: { tosReacceptRequired?: boolean } } | null)
        ?.data;
      if (!data?.tosReacceptRequired) return;

      // `dialogStore` de-dupes by component, so a user mashing a blocked button gets one modal.
      dialogStore.trigger({
        component: TosModal,
        props: {
          slug: 'tos',
          fieldKey: tosMeta.fieldKey,
          hashFieldKey: tosMeta.hashFieldKey,
          contentHash: tosMeta.hash,
          scrollToId: TOS_REACCEPTANCE_SECTION,
          onAccepted: async () => {
            // Lifts the mute server-side, then refreshes. In this order deliberately: refreshing
            // first would re-seed the session while it is still muted.
            await acceptTos.mutateAsync().catch(() => undefined);
            await currentUser.refresh();
          },
        },
      });
    });
  }, [acceptTos, currentUser, queryClient, tosMeta]);
}
