import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { useAppContext } from '~/providers/AppProvider';
import { showErrorNotification } from '~/utils/notifications';
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
  // `mutateAsync`, not the result object: react-query returns a fresh object every render, so
  // depending on it re-subscribes this effect on every render of the app root.
  const { mutateAsync: acceptTos } = trpc.strike.acceptTosAfterMute.useMutation();

  useEffect(() => {
    if (!currentUser || !tosMeta) return;

    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;

      const data = (event.action.error as { data?: { tosReacceptRequired?: boolean } } | null)
        ?.data;
      if (!data?.tosReacceptRequired) return;

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
            // Lifts the mute server-side, then refreshes. In this order deliberately: refreshing
            // first would re-seed the session while it is still muted.
            const result = await acceptTos().catch(() => undefined);
            await currentUser.refresh();

            // The service distinguishes 'a moderator muted you' and 'you are queued for review' from a
            // release. Closing the modal on those without a word leaves the user believing they are
            // unblocked, and their next action refused again with no explanation.
            if (!result?.unmuted) {
              showErrorNotification({
                title: 'Your account is still restricted',
                error: new Error(
                  result?.reason === 'review'
                    ? 'A moderator is reviewing your account. Accepting the Terms does not lift this.'
                    : 'Thanks for accepting. A moderator will need to lift this restriction.'
                ),
              });
            }
          },
        },
      });
    });
  }, [acceptTos, currentUser, queryClient, tosMeta]);
}
