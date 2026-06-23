import type { RouterOutput } from '~/types/router';

// The tRPC output shape of `announcement.getAnnouncements` — what the SSR seed
// and the query's `data`/`initialData` are typed as.
export type AnnouncementsSeed = RouterOutput['announcement']['getAnnouncements'];

const toDate = (v: unknown): Date | undefined =>
  v == null ? undefined : v instanceof Date ? v : new Date(v as string | number);

/**
 * Revive the Date fields of an SSR-injected announcements seed.
 *
 * The seed travels to the client via Next pageProps (plain JSON), which
 * stringifies `createdAt`/`startsAt`/`endsAt` to ISO strings — but a live
 * superjson tRPC fetch returns real Date objects. We revive the seed so the
 * React Query cache holds the SAME shape whether it was SSR-seeded or later
 * refetched (the display path doesn't read these dates today, but keeping the
 * shape identical avoids a silent seed-vs-refetch divergence).
 *
 * `startsAt`/`createdAt` are always present on the resolver output
 * (`startsAt ?? createdAt`); `endsAt` is nullable. Pure + dependency-light so it
 * can be unit-tested without pulling the provider's React/trpc graph.
 */
export function reviveAnnouncementsSeed(
  announcements?: AnnouncementsSeed
): AnnouncementsSeed | undefined {
  if (!announcements) return undefined;
  return announcements.map((announcement) => ({
    ...announcement,
    createdAt: toDate(announcement.createdAt) as Date,
    startsAt: toDate(announcement.startsAt) as Date,
    endsAt: toDate(announcement.endsAt) ?? null,
  }));
}
