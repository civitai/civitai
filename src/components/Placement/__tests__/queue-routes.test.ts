import { describe, expect, test } from 'vitest';
import { visiblePlacementSurfaceTabs } from '~/components/Placement/queue-routes';

const values = (flags: Parameters<typeof visiblePlacementSurfaceTabs>[0]) =>
  visiblePlacementSurfaceTabs(flags).map((tab) => tab.value);

describe('visiblePlacementSurfaceTabs', () => {
  test('stickers and remixes only, with no flags', () => {
    expect(values({})).toEqual(['sticker', 'remix']);
  });

  test('each flag opens its own tab and no other', () => {
    expect(values({ storylines: true })).toEqual(['sticker', 'remix', 'storyline']);
    expect(values({ creatorPromotions: true })).toEqual(['sticker', 'remix', 'promotion']);
  });
});
