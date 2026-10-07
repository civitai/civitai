import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useAppContext } from '~/providers/AppProvider';
import { showInfoNotification } from '~/utils/notifications';
import { TOS_REACCEPTANCE_SECTION } from '~/server/common/tos-reacceptance';

const TosModal = dynamic(() => import('~/components/ToSModal/TosModal'), { ssr: false });

/**
 * Opens the ToS at the section a struck user broke, at the moment a mute blocks them from acting.
 * Accepting is recorded but does not lift the mute.
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
  // `mutateAsync`, not the result object: react-query returns a fresh object every render, so
  // depending on it re-subscribes this effect on every render of the app root.
  const { mutateAsync: acceptTos } = trpc.strike.acceptTosAfterMute.useMutation();
  // Once accepted, later blocked actions get the plain refusal instead of the same document again.
  const acceptedRef = useRef(false);

  useEffect(() => {
    if (!currentUser || !tosMeta) return;

    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;

      const data = (event.action.error as { data?: { tosReacceptRequired?: boolean } } | null)
        ?.data;
      if (!data?.tosReacceptRequired || acceptedRef.current) return;

      dialogStore.trigger({
        // Fixed id: the store de-dupes on it and defaults to `Date.now()`, so without this a second
        // blocked click stacks a second copy of the same modal.
        id: 'tos-reacceptance',
        component: TosModal,
        props: {
          slug: 'tos',
          fieldKey: tosMeta.fieldKey,
          hashFieldKey: tosMeta.hashFieldKey,
          contentHash: tosMeta.hash,
          scrollToId: TOS_REACCEPTANCE_SECTION,
          onAccepted: async () => {
            const result = await acceptTos().catch(() => undefined);
            if (!result?.accepted) return;
            acceptedRef.current = true;
            showInfoNotification({
              title: 'Your account is still restricted',
              message:
                'Thanks for accepting. The restriction lifts automatically once your strike points drop, or when a moderator lifts it.',
              autoClose: false,
            });
          },
        },
      });
    });
  }, [acceptTos, currentUser, queryClient, tosMeta]);
}
