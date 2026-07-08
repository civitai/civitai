import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import dynamic from 'next/dynamic';
import type { AnnouncementType } from '~/server/schema/announcement.schema';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const AnnouncementsCarousel = dynamic(
  () => import('~/components/Announcements/AnnouncementsCarousel')
);

// Approximate rendered height (px) of one announcement carousel slide (title +
// a short markdown body + action button row), measured from production. Used as
// the pre-hydration space reserve + a floor once the carousel mounts, so the
// tall masonry feed below doesn't reflow when the isClient-gated carousel
// appears. Variable markdown makes it approximate: a taller announcement leaves
// a small residual shift (still far less than the full un-reserved push), a
// shorter one leaves a little dead space (never a functional break). Tune here.
const ANNOUNCEMENT_RESERVE_PX = 162;

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

  // CLS reserve (flag-gated). The SSR seed tells us (dismissed-independently)
  // whether an announcement of this type exists — `seededCount`. Hold its space
  // so the feed doesn't shift when the carousel mounts. Active while the seed has
  // an announcement AND we haven't resolved to "nothing to show" (post-hydration
  // with everything dismissed) — that last case releases the reserve so a heavy
  // dismisser isn't left with permanent dead space.
  const reserveActive =
    features.feedReserveCls && seededCount > 0 && (!isClient || announcements.length > 0);

  if (!announcements.length) {
    // Nothing surfaced yet. Pre-hydration with a seeded announcement → hold the
    // space (server + first client render agree: both have announcements=[] via
    // the isClient gate and the same seededCount, so no hydration mismatch).
    if (reserveActive) {
      return (
        <div
          className={className}
          style={{ minHeight: ANNOUNCEMENT_RESERVE_PX }}
          aria-hidden="true"
          data-testid="announcements-cls-reserve"
        />
      );
    }
    return null;
  }

  return (
    <AnnouncementsCarousel
      className={className}
      type={type}
      minHeight={reserveActive ? ANNOUNCEMENT_RESERVE_PX : undefined}
    />
  );
}
