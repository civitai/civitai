import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { StickerPlacementBar } from '~/components/Sticker/StickerPlacementBar';

/**
 * The invitation is a claim that this image has no stickers. `total` is fed by
 * two queries, and every way of not knowing the answer — either still loading,
 * or the counts request having failed — reads as zero. Show it too early and a
 * press opens a Buzz purchase tray on an image that already has stickers,
 * instead of revealing them.
 */
const IMAGE_ID = 1;
const INVITATION = 'No stickers yet — place the first one';
const PLUS = 'Place a sticker';

const queryState = {
  counts: {} as Record<number, number>,
  countsLoading: false,
  countsError: false,
  placementsLoading: false,
  pending: [] as { imageId: number; isPending: boolean }[],
};

// Spread the real module: a hand-listed mock couples this test to the whole
// transitive import graph of the bar, and nothing warns when that graph grows.
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useStickerPlacementCounts: () => ({
    counts: queryState.counts,
    isLoading: queryState.countsLoading,
    isError: queryState.countsError,
  }),
  useStickerPlacements: () => ({
    byImage: new Map(queryState.pending.length ? [[IMAGE_ID, queryState.pending]] : []),
    isLoading: queryState.placementsLoading,
  }),
  useImagePlacementSpace: () => ({
    space: { mode: 'open', price: 100, ownerId: 999 },
    isLoading: false,
  }),
}));
// The tray renders a fixed panel over the viewport and owns its own queries;
// none of that is what this file is about.
vi.mock('~/components/Sticker/StickerPlacementTray', () => ({
  StickerPlacementTray: () => null,
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickerPlacement: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

const renderBar = async () => {
  renderWithProviders(<StickerPlacementBar imageId={IMAGE_ID} />);
  // Anchored on "a button exists" rather than on a name. Every name in this row
  // is either the thing under test or, if the names collide, ambiguous — and an
  // ambiguous locator turns a failure into a 15 s strict-mode retry rather than
  // the assertion it should be.
  await expect.element(page.getByRole('button').first()).toBeInTheDocument();
};

const invitations = () => page.getByRole('button', { name: INVITATION }).elements().length;

describe('StickerPlacementBar', () => {
  test('claims the image is empty only once both queries have arrived', async () => {
    Object.assign(queryState, {
      counts: {},
      countsLoading: false,
      countsError: false,
      placementsLoading: false,
      pending: [],
    });
    await renderBar();

    expect(invitations()).toBe(1);
  });

  test('gives the invitation and the plus different names, though they do the same thing', async () => {
    Object.assign(queryState, {
      counts: {},
      countsLoading: false,
      countsError: false,
      placementsLoading: false,
      pending: [],
    });
    await renderBar();

    // They share a Button.Group and an action. Identical accessible names would
    // announce one control twice to a screen reader.
    expect(page.getByRole('button', { name: PLUS }).elements()).toHaveLength(1);
    expect(invitations()).toBe(1);
  });

  test('waits for the counts query rather than reading its absence as zero', async () => {
    Object.assign(queryState, { countsLoading: true });
    await renderBar();

    expect(invitations()).toBe(0);
  });

  test('waits for the placements query too, which also feeds the total', async () => {
    Object.assign(queryState, { countsLoading: false, placementsLoading: true });
    await renderBar();

    expect(invitations()).toBe(0);
  });

  test('never claims empty on a failed count, which is not the same as zero', async () => {
    Object.assign(queryState, { placementsLoading: false, countsError: true });
    await renderBar();

    expect(invitations()).toBe(0);
  });

  test('shows the count, not the invitation, once there is something to count', async () => {
    Object.assign(queryState, { countsError: false, counts: { [IMAGE_ID]: 3 } });
    await renderBar();

    expect(invitations()).toBe(0);
    expect(page.getByRole('button', { name: /^3 stickers$/ }).elements()).toHaveLength(1);
  });

  test("counts the viewer's own pending placement, which the count query omits", async () => {
    Object.assign(queryState, {
      counts: {},
      pending: [{ imageId: IMAGE_ID, isPending: true }],
    });
    await renderBar();

    expect(invitations()).toBe(0);
    expect(page.getByRole('button', { name: /^1 sticker$/ }).elements()).toHaveLength(1);
  });
});
