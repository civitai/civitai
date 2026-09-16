import { planDismissalRequests } from '~/components/Announcements/announcement-dismissal-plan';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { MAX_ANNOUNCEMENT_DISMISSALS_PER_REQUEST } from '~/server/schema/announcement.schema';
import { trpc, trpcVanilla } from '~/utils/trpc';

/**
 * The account-level side of announcement dismissals.
 *
 * The device stores — the announcements cookie, and localStorage for creator announcements —
 * are unchanged and still the only thing that decides what renders, including during SSR.
 * This module adds a second, slower store so a dismissal made on one device is not undone by
 * opening another: every dismissal a signed-in user makes is also written to their account,
 * and what the account holds is merged into the device store while the session runs.
 */

// Long enough that the merge is not a per-navigation fetch, short enough that a dismissal made
// on another device arrives inside a session rather than on the next cold load. Deliberately
// NOT a once-per-device sync, which reconciles once and then drifts forever.
const DISMISSALS_STALE_TIME = 5 * 60 * 1000;

const EMPTY: number[] = [];

/**
 * Fire-and-forget: the local dismissal has already happened and must not depend on this, so a
 * failure here costs cross-device sync and nothing else.
 *
 * Signed out there is no account to write to — the procedure is protected — and the device
 * store is the whole story, exactly as before.
 */
export function recordAnnouncementDismissals(ids: number | number[]) {
  const batches = planDismissalRequests({
    ids: Array.isArray(ids) ? ids : [ids],
    isAuthed: typeof window !== 'undefined' && !!window.isAuthed,
    batchSize: MAX_ANNOUNCEMENT_DISMISSALS_PER_REQUEST,
  });

  for (const batch of batches)
    trpcVanilla.announcement.dismissAnnouncements.mutate({ ids: batch }).catch(() => undefined);
}

/** The account's dismissed ids, already scoped server-side to announcements that can still show. */
export function useServerDismissedAnnouncements() {
  const currentUser = useCurrentUser();
  const { data } = trpc.announcement.getDismissedAnnouncements.useQuery(undefined, {
    enabled: !!currentUser,
    staleTime: DISMISSALS_STALE_TIME,
  });

  return data ?? EMPTY;
}
