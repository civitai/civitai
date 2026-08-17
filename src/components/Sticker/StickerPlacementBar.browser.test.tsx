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

// What the bar asked for, not just what it did with the answer. Reveal-off hides
// pending placements, and the obvious tidy-up afterwards is to stop fetching them
// — which also stops COUNTING them, so an owner following a notification lands on
// a chip reading zero with nothing on the page that reveals what they came for.
// Asserting only the total leaves that entirely unguarded.
const placementsEnabled: (boolean | undefined)[] = [];

const queryState = {
  counts: {} as Record<number, number>,
  countsLoading: false,
  countsError: false,
  placementsLoading: false,
  pending: [] as { imageId: number; isPending: boolean }[],
  /**
   * The creator's free capacity, and how much of it is left.
   *
   * Both, because `freeSlotsRemaining: 0` means two different things — "takes no
   * free stickers" and "all slots currently held" — and the bar's copy has to
   * tell them apart. A fixture carrying only the remainder could not express the
   * difference, so the tests would agree with either behaviour.
   */
  freeSlots: 0,
  freeSlotsRemaining: 0,
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
  useStickerPlacements: (_ids: number[], enabled?: boolean) => {
    placementsEnabled.push(enabled);
    return {
      byImage: new Map(queryState.pending.length ? [[IMAGE_ID, queryState.pending]] : []),
      isLoading: queryState.placementsLoading,
    };
  },
  useImagePlacementSpace: () => ({
    space: {
      mode: 'open',
      price: 100,
      ownerId: 999,
      freeSlots: queryState.freeSlots,
      freeSlotsRemaining: queryState.freeSlotsRemaining,
    },
    isLoading: false,
  }),
}));
// The tray renders a fixed panel over the viewport and owns its own queries;
// none of that is what this file is about.
vi.mock('~/components/Sticker/StickerPlacementTray', () => ({
  StickerPlacementTray: () => null,
}));
// The history panel is the same case, and leaving it in broke the `enabled`
// assertion below rather than anything it was testing: it calls
// `useStickerPlacements` too, with `enabled: opened` — false until someone opens
// it — and the mock above collects EVERY caller's argument into one array. So
// the bar's own `enabled: true` arrived alongside the panel's `false`.
//
// Mocked out rather than relaxing the assertion to `.some(...)`: `.some` passes
// even when the bar's own query is disabled, which is the exact regression the
// test exists to catch.
vi.mock('~/components/Sticker/StickerHistoryPanel', () => ({
  StickerHistoryButton: () => null,
  StickerHistoryPanel: () => null,
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

  test('fetches placements for a signed-in viewer even though reveal hides them', async () => {
    Object.assign(queryState, { counts: {}, pending: [{ imageId: IMAGE_ID, isPending: true }] });
    placementsEnabled.length = 0;
    await renderBar();

    // The count above is only right because this query ran. Passing `false` here
    // renders identically until an owner arrives from a notification and finds
    // nothing to act on, so the argument is the thing worth pinning.
    expect(placementsEnabled.length).toBeGreaterThan(0);
    expect(placementsEnabled.every((enabled) => enabled === true)).toBe(true);
  });
});

/**
 * The one number the sticker button carries.
 *
 * Every state here is absorbing — nothing on a timer, nothing the component
 * tears down — so these assert after a settled render rather than awaiting a
 * state that could leave.
 */
describe('StickerPlacementBar — free slots', () => {
  const settled = {
    counts: {},
    countsLoading: false,
    countsError: false,
    placementsLoading: false,
    pending: [],
  };

  const placeButton = () => page.getByRole('button', { name: /^Place a sticker/ });
  // By exact name, because the comparison below renders twice in one test and
  // both buttons stay mounted — a pattern locator resolves to two elements there
  // and fails on strict mode rather than on the property being tested.
  const backgroundOf = async (name: string) =>
    getComputedStyle(await page.getByRole('button', { name }).element()).backgroundColor;

  test('carries the remaining count out of the creator capacity', async () => {
    Object.assign(queryState, settled, { freeSlots: 4, freeSlotsRemaining: 2 });
    await renderBar();

    await expect.element(page.getByText('2 of 4 free')).toBeInTheDocument();
    // On the accessible name too. A number only a sighted user can read is not
    // the button carrying it.
    expect(
      page.getByRole('button', { name: 'Place a sticker · 2 of 4 free' }).elements()
    ).toHaveLength(1);
  });

  /**
   * The ambiguity that needed two numbers to resolve. A creator whose slots are
   * all held still has something to say, because a slot comes back the moment
   * one is declined — so this state reads `0 of 4`, not silence.
   */
  test('says nothing about free stickers when the creator takes none', async () => {
    Object.assign(queryState, settled, { freeSlots: 0, freeSlotsRemaining: 0 });
    await renderBar();

    expect(page.getByText(/free$/).elements()).toHaveLength(0);
    // `exact`, because the default is a substring match — so the bare name also
    // matched "Place a sticker · 0 of 0 free" and the assertion survived the
    // mutation `showsFree = canPlace`, which is the one it exists to catch.
    expect(
      page.getByRole('button', { name: 'Place a sticker', exact: true }).elements()
    ).toHaveLength(1);
  });

  test('still reports the capacity when every slot is currently held', async () => {
    Object.assign(queryState, settled, { freeSlots: 4, freeSlotsRemaining: 0 });
    await renderBar();

    await expect.element(page.getByText('0 of 4 free')).toBeInTheDocument();
  });

  /**
   * The shiny treatment, asserted as a difference rather than as a colour: what
   * has to be true is that a slot being available looks unlike one that is not.
   * Pinning the exact rgba would fail on a theme change that kept the behaviour.
   */
  test('draws the button differently when a slot is available', async () => {
    // A stickered image, deliberately. On an empty one the button already wears
    // this tint as half of the "place the first one" invitation, so both renders
    // would come back identical and the test would pass for the wrong reason —
    // or fail, as it did, on a cause that has nothing to do with free slots.
    const stickered = { ...settled, counts: { [IMAGE_ID]: 3 } };

    Object.assign(queryState, stickered, { freeSlots: 4, freeSlotsRemaining: 1 });
    await renderBar();
    const available = await backgroundOf('Place a sticker · 1 of 4 free');

    Object.assign(queryState, stickered, { freeSlots: 4, freeSlotsRemaining: 0 });
    await renderBar();
    const taken = await backgroundOf('Place a sticker · 0 of 4 free');

    expect(available).not.toBe(taken);
  });

  /**
   * 🔴 The bar must never promise free, and the count is why it is tempting to.
   *
   * `freeSlotsRemaining` is the CREATOR's capacity. It says nothing about this
   * viewer — somebody who spent today's allowance, or already free-placed on this
   * image, has no free option at all — and only the standing query answers that,
   * which this bar deliberately does not make because it renders per feed card.
   * So a "free" label here is read by the people it is false for, who then open
   * the tray and pay a number they were never shown.
   *
   * Asserted across both capacity states, because the defect only appeared in one
   * of them: a test pinned to the empty case passes while the promise is made.
   */
  test.each([
    ['slots remaining', 2],
    ['slots all taken', 0],
  ])('quotes the price and never promises free — %s', async (_name, remaining) => {
    Object.assign(queryState, settled, { freeSlots: 4, freeSlotsRemaining: remaining });
    await renderBar();

    await placeButton().hover();
    await expect.element(page.getByText('Place a sticker · 100 Buzz')).toBeInTheDocument();
    expect(page.getByText(/·\s*free/).elements()).toHaveLength(0);
  });

  /**
   * The count itself stays, and this is the line between the two: a number about
   * the creator's capacity is a fact the bar has, and a claim about what THIS
   * viewer will be charged is not.
   */
  test('still states the creator capacity it does know', async () => {
    Object.assign(queryState, settled, { freeSlots: 4, freeSlotsRemaining: 2 });
    await renderBar();

    await expect.element(page.getByText('2 of 4 free')).toBeInTheDocument();
  });
});
