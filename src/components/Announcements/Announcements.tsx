import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';
import { useAppContext } from '~/providers/AppProvider';

const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

// Approximate rendered height of a single announcement banner (the card uses an
// image variant with `min-h-40` = 160px, plus the wrapper's `mb-3`). Used only to
// reserve layout space so the banner's post-hydration appearance doesn't shove the
// page content down (a large CLS source on the home page, which has a tall content
// tree below the banner). Slightly under the real height by design — better to
// reserve a touch less than to leave dead whitespace; the residual shift is small.
const ANNOUNCEMENT_RESERVED_MIN_HEIGHT = 160;

export function Announcements() {
  const { data } = useGetAnnouncements();

  // `useGetAnnouncements` intentionally returns [] on the server AND the first
  // client render (it gates on useIsClient to keep the localStorage `dismissed`
  // set from causing a hydration mismatch), then surfaces the banner only after
  // hydration — which is exactly what shifts the page. The SSR seed itself
  // (useAppContext) IS available identically on the server and the first client
  // render, so we can reserve the banner's height from it deterministically
  // (no hydration mismatch) and let the real carousel fill that reserved space.
  const { announcements: seed } = useAppContext();
  const hasSeededAnnouncement = (seed?.length ?? 0) > 0;

  const announcements = data.filter((x) => !x.dismissed);

  // Reserve space when the SSR seed has an announcement, even before the
  // post-hydration carousel renders. Once hydrated, if the user had dismissed
  // every seeded announcement, the slot collapses (a minor upward adjustment in
  // that edge case only); the common case (an active, undismissed announcement)
  // sees the banner fill the already-reserved height with no shift.
  // Pre-hydration (data === [] but a seed exists): render a same-width/margin
  // placeholder that reserves the banner height, so when the carousel mounts
  // post-hydration it fills the already-reserved slot instead of pushing the
  // page content down.
  if (!announcements.length) {
    if (!hasSeededAnnouncement) return null;
    return (
      <div
        aria-hidden
        style={{ minHeight: ANNOUNCEMENT_RESERVED_MIN_HEIGHT }}
        // eslint-disable-next-line tailwindcss/no-custom-classname
        className="announcements-placeholder peer container mb-3"
      />
    );
  }

  return <AnnouncementsCarousel />;
}
