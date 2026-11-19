import { describe, expect, it } from 'vitest';
import { shouldDisplayUserNullState } from '~/components/Profile/profile.utils';
import type { ProfileSectionSchema } from '~/server/schema/user-profile.schema';

// Every other section switched off, so "Most recent" alone decides what the page shows.
const onlyRecent: ProfileSectionSchema[] = [
  { key: 'showcase', enabled: false },
  { key: 'popularModels', enabled: false },
  { key: 'popularArticles', enabled: false },
  { key: 'modelsOverview', enabled: false },
  { key: 'imagesOverview', enabled: false },
  { key: 'recentReviews', enabled: false },
  { key: 'shop', enabled: false },
  { key: 'onSale', enabled: false },
  { key: 'creatorJourney', enabled: false },
  { key: 'recent', enabled: true },
];
const userWithProfile = {
  bannedAt: null,
  profile: { profileSectionsSettings: onlyRecent, showcaseItems: [] },
} as never;
const overview = (counts: { imageCount?: number; videoCount?: number; articleCount?: number }) => ({
  modelCount: 3,
  imageCount: 0,
  videoCount: 0,
  articleCount: 0,
  hasReceivedReviews: false,
  ...counts,
});

describe('shouldDisplayUserNullState with the Most recent section', () => {
  it.each([{ imageCount: 2 }, { videoCount: 1 }, { articleCount: 1 }])(
    'shows the profile when Most recent has something to show (%o)',
    (counts) => {
      expect(
        shouldDisplayUserNullState({
          overview: overview(counts),
          userWithProfile,
          withRecentSection: true,
        })
      ).toBe(false);
    }
  );

  it('shows the empty state when Most recent has nothing to show', () => {
    expect(
      shouldDisplayUserNullState({
        overview: overview({}),
        userWithProfile,
        withRecentSection: true,
      })
    ).toBe(true);
  });

  it('ignores Most recent for a viewer without the redesign, who cannot see it', () => {
    expect(
      shouldDisplayUserNullState({ overview: overview({ imageCount: 2 }), userWithProfile })
    ).toBe(true);
  });
});
