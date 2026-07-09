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
 *     dismissed — directly into the SSR HTML. No placeholder reserve, no
 *     post-hydration collapse (the net-negative mechanism this replaces).
 *   - Flag OFF / non-`site`: the hook keeps the `isClient` gate, so `data` is empty
 *     on the server + first client paint and this renders `null` there, exactly as
 *     before — byte-identical.
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
