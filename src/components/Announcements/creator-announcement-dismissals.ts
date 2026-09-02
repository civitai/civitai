import { createDismissalStore, localStorageDismissalStorage } from '~/store/dismissal-store';

/**
 * Dismissed creator announcements, in localStorage rather than the announcements cookie.
 *
 * The cookie exists so the SERVER can render the sitewide carousel at its true height from
 * frame 0, and its bucket map is `Record<AnnouncementType, number[]>` — deliberately a
 * closed literal, so a creator bucket cannot be added without widening `AnnouncementType`,
 * which is what the sitewide queries filter on. Creator announcements render only in the
 * notifications panel, which is client-only and never SSRs, so none of the cookie's
 * property is needed here and paying for it would mean reaching into sitewide filtering.
 */
export const CREATOR_ANNOUNCEMENTS_DISMISSED_KEY = 'creator-announcements-dismissed';

const BUCKET = 'creators';

const store = createDismissalStore<number, typeof BUCKET>({
  storage: localStorageDismissalStorage({
    key: CREATOR_ANNOUNCEMENTS_DISMISSED_KEY,
    buckets: [BUCKET],
    isId: (value): value is number => typeof value === 'number',
  }),
  defaultBucket: BUCKET,
});

export const useDismissedCreatorAnnouncements = () => store.useDismissed();

export function dismissCreatorAnnouncement(id: number) {
  store.dismiss(id);
}

export function pruneDismissedCreatorAnnouncements(live: Iterable<number>) {
  store.prune(live);
}
