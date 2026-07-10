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
 *   - `feedReserveCls` ON + `type === 'site'` + a non-dismissed announcement:
 *     render the REAL carousel inside a persistent `min-h` parent. The wrapper is
 *     gated on the seed (`serverExposedCount`) PRE-hydration — identical on the
 *     server render and first client paint (`exposeSSR` is a base/host-level flag
 *     held in `useState`, stable, NOT a laggy per-user overlay), so no hydration
 *     mismatch and the space is held from frame 0 — and on the LIVE
 *     `announcements.length` POST-hydration, so a live dismiss of the last
 *     announcement collapses the reserve immediately (no dead space until reload).
 *     In steady state the carousel fills ~162px, so there is no dead space beyond
 *     the floor.
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
 * reserve; post-hydration the just-migrated store empties `announcements` → the
 * live-state gate drops the wrapper = one clean, self-healing collapse (no lingering
 * dead space). Not a hydration error (first paint == SSR, both off the empty server
 * seed); fully settled on the 2nd load (the cookie now exists → seed 0 → no wrapper).
 */
export function Announcements({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const { data, exposeSSR, serverExposedCount, isClient } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  // PERSISTENT reserve parent, gated so it MATCHES SSR pre-hydration but FOLLOWS
  // live state after:
  //   - pre-hydration (isClient=false, i.e. the server render AND the first client
  //     paint): gate on the seed-driven `serverExposedCount` — identical on both,
  //     so no hydration mismatch, and the space is held from frame 0.
  //   - post-hydration (isClient=true): gate on the LIVE `announcements.length`, so
  //     when the user dismisses the last announcement the wrapper is REMOVED and the
  //     reserved space collapses immediately (no lingering dead space until reload).
  //     That collapse is USER-INITIATED (the dismiss click) → excluded from CLS via
  //     `hadRecentInput`, and is the expected UX. Dismissing one of several keeps the
  //     reserve (length still > 0).
  // Because the carousel is STATIC-imported, the inner is never transiently null
  // while the wrapper shows (pre-hydration `serverExposedCount > 0` ⇒
  // `announcements.length > 0`; post-hydration the gate IS `announcements.length`),
  // so the min-height floor is belt-and-suspenders — the flash cannot return.
  // `exposeSSR` already implies `type === 'site'`; the explicit check is defensive.
  const showReserve =
    exposeSSR && type === 'site' && (isClient ? announcements.length > 0 : serverExposedCount > 0);
  if (showReserve) {
    return (
      <div className={clsx(className, ANNOUNCEMENT_RESERVE_CLASS)} data-testid="announcements-cls-reserve">
        <AnnouncementsCarousel type={type} />
      </div>
    );
  }

  // Flag OFF / non-site / server saw nothing (or dismissed): byte-identical to the
  // #3018 behaviour — null on the server + first client paint, carousel afterwards.
  if (!announcements.length) return null;

  return <AnnouncementsCarousel className={className} type={type} />;
}
