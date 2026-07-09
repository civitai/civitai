import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import clsx from 'clsx';
// STATIC import (was `dynamic()`): the carousel is SSR-rendered above the fold in
// the exposed case, so lazy-loading it only adds a client chunk-load gap where the
// dynamic component renders `null` until its chunk resolves — an unmount that
// collapses the reserved height and shifts the feed up, then remounts and shifts
// it back (the exact double-CLS this fix targets). Importing it statically bundles
// it with the initial render, so it is present from frame 0 with no load gap.
// AnnouncementsCarousel is SSR-safe (embla only touches the DOM in effects; no
// render-time window/document/matchMedia).
import AnnouncementsCarousel from '~/components/Announcements/AnnouncementsCarousel';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

// Responsive reserved height for one announcement carousel slide, measured from
// production (#3000): ~162px on desktop, ~203px on mobile (title/markdown/button-
// row wrap taller in a narrow column). The persistent parent below carries this
// min-height floor so the reserved space is held CONTINUOUSLY even if the inner
// carousel EVER momentarily renders null across the SSR→hydration handoff — no
// 162→0→162 collapse, so the tall masonry feed below never reflows. Written as
// literal Tailwind classes so JIT emits them; tune here.
const ANNOUNCEMENT_RESERVE_CLASS = 'min-h-[203px] md:min-h-[162px]';

/**
 * Above-feed announcement banner.
 *
 * The feed-CLS treatment combines #3018's SSR-exact dismiss (the carousel — or
 * nothing — lands in the initial server HTML, driven by the server-read cookie via
 * `useGetAnnouncements`) with #3000's anti-collapse mechanism (a PERSISTENT
 * min-height parent that stays mounted across the SSR→hydration handoff):
 *
 *   - `feedReserveCls` ON + `type === 'site'` + the SERVER saw a non-dismissed
 *     announcement (`serverExposedCount > 0`): render the REAL carousel inside a
 *     persistent `min-h` parent. The wrapper's existence is decided from the SSR
 *     seed (`exposeSSR` is a base/host-level flag held in `useState` — stable, NOT
 *     a laggy per-user overlay — and `serverExposedCount` rides the SSR snapshot),
 *     so it is IDENTICAL on the server render and the first client paint and never
 *     unmounts on a client transient. The `min-h` floor holds the space even if the
 *     inner carousel briefly renders null, so the feed never collapses. In steady
 *     state the carousel fills ~162px, so there is no dead space beyond the floor.
 *   - Flag OFF / non-`site` / server saw nothing (or saw it dismissed): NO wrapper.
 *     Byte-identical to today — the hook's `isClient` gate zeroes `data` on the
 *     server + first client paint, so this renders `null` there exactly as before,
 *     and a server-side dismisser reserves NO dead space.
 *
 * ONE bounded exception (unchanged from #3018): a user who dismissed a STILL-ACTIVE
 * announcement under the OLD localStorage bundle, on their FIRST load of the new
 * bundle with the flag ON. The localStorage→cookie migration runs CLIENT-side only,
 * so on that first load there is no cookie server-side → the seed is empty →
 * `serverExposedCount > 0` → SSR + first client paint render the carousel inside the
 * reserve; post-hydration the just-migrated store filters it out and the inner goes
 * null — but the persistent `min-h` parent HOLDS the height, so there is no feed
 * shift (strictly better than the pre-fix double-shift). Not a hydration error
 * (first paint == SSR, both off the empty server seed); self-heals on the 2nd load
 * (the cookie now exists → `serverExposedCount` 0 → no wrapper, no dead space).
 */
export function Announcements({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const { data, exposeSSR, serverExposedCount } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  // PERSISTENT reserve parent. Gated on a hydration-STABLE, seed-driven decision
  // (`exposeSSR` base flag + `serverExposedCount` from the SSR snapshot) so this
  // exact <div> — same element type, same tree position, no changing `key` —
  // renders in the SSR HTML and STAYS mounted from server → hydration → steady
  // state. Only the INNER content can swap (carousel ⇆ null), and the min-height
  // lives on THIS parent, so the reserved space is held continuously with no
  // collapse gap. Server + first client paint agree on both the wrapper and its
  // contents (the hook exposes the same seed-driven `data`), so no hydration
  // mismatch. `exposeSSR` already implies `type === 'site'`; the explicit check is
  // defensive.
  if (exposeSSR && type === 'site' && serverExposedCount > 0) {
    return (
      <div
        className={clsx(className, ANNOUNCEMENT_RESERVE_CLASS)}
        data-testid="announcements-cls-reserve"
        aria-hidden={announcements.length ? undefined : true}
      >
        {announcements.length ? <AnnouncementsCarousel type={type} /> : null}
      </div>
    );
  }

  // Flag OFF / non-site / server saw nothing (or dismissed): byte-identical to the
  // #3018 behaviour — null on the server + first client paint, carousel afterwards.
  if (!announcements.length) return null;

  return <AnnouncementsCarousel className={className} type={type} />;
}
