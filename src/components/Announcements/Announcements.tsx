import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';
import clsx from 'clsx';
import type { AnnouncementType } from '~/server/schema/announcement.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

// Responsive reserved height for one announcement carousel slide, measured from
// production: ~162px on desktop, ~203px on mobile (title/markdown/button-row wrap
// taller in a narrow column). Reserve the LARGER per-viewport so neither
// under-reserves (an under-reserve leaves a residual downshift; an over-reserve
// is only cosmetic dead space, never a shift). Variable markdown still makes it
// approximate — a longer announcement leaves a small residual shift, far less
// than the full un-reserved push. Written as literal Tailwind classes so JIT
// emits them; tune here.
const ANNOUNCEMENT_RESERVE_CLASS = 'min-h-[203px] md:min-h-[162px]';

export function Announcements({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const features = useFeatureFlags();
  const { data, seededCount, isClient } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  // CLS reserve (flag-gated). The SSR seed tells us — dismissed-independently, via
  // `seededCount` — whether a `site` announcement exists, so we can hold its space
  // from first paint so the tall masonry feed below doesn't reflow when the
  // isClient-gated / dynamically-imported carousel mounts. Scoped to `type ===
  // 'site'` (the above-feed placement in AppLayout): the `generator`/`training`
  // placements sit above a form/wizard, not a huge feed, so they aren't the CLS
  // problem and don't need the reserve. Released post-hydration if everything is
  // dismissed (see the fall-through below) so a heavy dismisser keeps no dead space.
  const reserveActive =
    features.feedReserveCls &&
    type === 'site' &&
    seededCount > 0 &&
    (!isClient || announcements.length > 0);

  if (reserveActive) {
    // PERSISTENT parent: this same <div> renders in the SSR HTML and stays mounted
    // (no key, same element type + tree position) from server → hydration → the
    // carousel's dynamic-import load. Only the INNER content swaps (spacer → the
    // real carousel), and the min-height lives on THIS parent, so the reserved
    // space is held CONTINUOUSLY across the handoff — no 162→0→162 collapse gap
    // (and therefore no double-shift) while the carousel chunk resolves. Server +
    // first client render agree (both: announcements=[] via the isClient gate,
    // same seededCount), so there's no hydration mismatch.
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

  // Flag OFF / non-site type / seed empty / post-hydration all-dismissed:
  // byte-identical to the original behavior.
  if (!announcements.length) return null;

  return <AnnouncementsCarousel className={className} type={type} />;
}
