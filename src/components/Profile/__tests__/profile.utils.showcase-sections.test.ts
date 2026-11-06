import { describe, expect, it } from 'vitest';
import {
  getAllAvailableProfileSections,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import type { ShowcaseSectionSchema } from '~/server/schema/user-profile.schema';

const showcase = (id: string): ShowcaseSectionSchema => ({
  id,
  type: 'Model',
  title: id,
  items: [1],
});
const keys = (sections: { key: string }[]) => sections.map((s) => s.key);

describe('getAllAvailableProfileSections with custom showcases', () => {
  it('keeps a placed custom section where the creator put it', () => {
    const sections = getAllAvailableProfileSections(
      [
        { key: 'custom:a', enabled: false },
        { key: 'popularModels', enabled: true },
      ],
      [showcase('a')]
    );
    expect(sections.slice(0, 2)).toEqual([
      { key: 'custom:a', enabled: false },
      { key: 'popularModels', enabled: true },
    ]);
  });

  it('drops the row of a deleted section', () => {
    const sections = getAllAvailableProfileSections([{ key: 'custom:gone', enabled: true }], []);
    expect(keys(sections)).not.toContain('custom:gone');
  });

  it('appends a new section last, enabled', () => {
    const sections = getAllAvailableProfileSections(
      [{ key: 'showcase', enabled: true }],
      [showcase('new')]
    );
    expect(sections.at(-1)).toEqual({ key: 'custom:new', enabled: true });
  });
});

describe('shouldDisplayUserNullState with custom showcases', () => {
  // A creator with nothing but a custom showcase: no models, images, articles or reviews.
  const overview = { modelCount: 0, imageCount: 0, articleCount: 0, hasReceivedReviews: false };
  const userWithProfile = {
    bannedAt: null,
    profile: { profileSectionsSettings: [], showcaseItems: [] },
  } as never;

  it('shows the profile when a custom showcase with items is enabled', () => {
    expect(
      shouldDisplayUserNullState({ overview, userWithProfile, showcaseSections: [showcase('a')] })
    ).toBe(false);
  });

  it('shows the empty state when the only showcase has no items', () => {
    expect(
      shouldDisplayUserNullState({
        overview,
        userWithProfile,
        showcaseSections: [{ ...showcase('a'), items: [] }],
      })
    ).toBe(true);
  });
});
