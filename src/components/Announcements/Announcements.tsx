import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

// ssr:true (the default) so, when `useGetAnnouncements` exposes the dismissed
// data server-side (flag ON, `site` placement), the REAL carousel lands in the
// initial server HTML at its true height — the durable feed-CLS fix. Next
// preloads the chunk for the initial render so hydration matches (no flash).
const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

/**
 * Above-feed announcement banner.
 *
 * The feed-CLS treatment is fully driven by `useGetAnnouncements`:
 *   - `feedReserveCls` ON + `type === 'site'`: the hook exposes the dismissed data
 *     on the server + first client paint (both read the same cookie), so this
 *     renders the real carousel — or nothing, if the active announcement is
 *     dismissed — directly into the SSR HTML. No placeholder reserve, and (for the
 *     steady state) no post-hydration collapse — the net-negative mechanism this
 *     replaces.
 *   - Flag OFF / non-`site`: the hook keeps the `isClient` gate, so `data` is empty
 *     on the server + first client paint and this renders `null` there, exactly as
 *     before — byte-identical.
 *
 * ONE bounded exception to "no post-hydration collapse": a user who dismissed a
 * STILL-ACTIVE announcement under the OLD localStorage bundle, on their FIRST load
 * of the new bundle with the flag ON. The localStorage→cookie migration only runs
 * CLIENT-side, so on that first load there is no cookie server-side → the seed is
 * empty → SSR + first client paint expose the carousel, then post-hydration the
 * (just-migrated) store filters it out = one upward shift. This is NOT a hydration
 * error (first paint == SSR, both off the empty server seed); it self-heals on the
 * 2nd load (the cookie now exists, so SSR renders nothing) and is scoped to the
 * flag's audience (mod-only today) + the rollout window. Accepted trade-off.
 */
export function Announcements({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const { data } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return <AnnouncementsCarousel className={className} type={type} />;
}
