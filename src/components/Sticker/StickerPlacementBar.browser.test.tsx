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
  /**
   * The VIEWER's half, and the reason this file changed.
   *
   * `undefined` is the in-flight state and is not zero: the bar must render no
   * free label at all until the answer lands, rather than showing the price and
   * then adding "free" a beat later on every card in a feed.
   */
  allowanceRemaining: undefined as number | undefined,
  /** The third rule, which only a per-image query can answer. */
  usedHere: false,
  /** Whether a viewer is signed in at all — the other half of the query guard. */
  signedIn: true,
};

/** What the bar passed as `enabled`, verbatim — see the cost test. */
const standingEnabled: (boolean | undefined)[] = [];

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
  // 🔴 No default value for `enabled`, deliberately. With `(enabled = true)` a
  // mutation dropping the guard at the callsite still pushes `true`, and the
  // control below stays green while a protected query fires for viewers who
  // cannot place — a 401 per page. Undefined must arrive as undefined.
  useFreePlacementStanding: (_imageId?: number, enabled?: boolean) => {
    standingEnabled.push(enabled);
    return {
      standing:
        queryState.allowanceRemaining == null
          ? undefined
          : {
              used: 1 - queryState.allowanceRemaining,
              remaining: queryState.allowanceRemaining,
              usedHere: queryState.usedHere,
              resetsAt: new Date('2026-08-21T00:00:00.000Z'),
            },
      isLoading: queryState.allowanceRemaining == null,
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
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (queryState.signedIn ? { id: 7 } : null),
}));

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
    // Both halves of the free question are reset here, so a test that forgets to
    // set one fails loudly instead of borrowing the previous test's value — the
    // "passes for the wrong reason" class this suite was rewritten to remove.
    allowanceRemaining: undefined as number | undefined,
    usedHere: false,
    signedIn: true,
  };

  // By exact name, because the comparison below renders twice in one test and
  // both buttons stay mounted — a pattern locator resolves to two elements there
  // and fails on strict mode rather than on the property being tested.
  const backgroundOf = async (name: string, exact = false) =>
    getComputedStyle(await page.getByRole('button', { name, exact }).element()).backgroundColor;

  /**
   * 🔴 The defect this suite was rewritten for.
   *
   * The label used to be `${freeSlotsRemaining} of ${freeSlots} free`, which is
   * the CREATOR's capacity and says nothing about the reader. Somebody who had
   * spent their one placement for the day saw "1 of 1 free" on every image in
   * the feed, pressed it, and was charged. Justin hit it live in a meeting; a
   * user hit it ninety minutes after launch and reported it as "there is no
   * actual free one at the moment".
   *
   * So "free" is allowed on screen only where BOTH scarcities hold, and the
   * number is the smaller of the two, because that is how many the reader can
   * actually take.
   */
  test('offers free only when the creator has a slot and the viewer has their day', async () => {
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
    });
    await renderBar();

    // One, not two: the creator's capacity is 2 and the viewer may take 1.
    await expect.element(page.getByText('1 free')).toBeInTheDocument();
    // On the accessible name too. A number only a sighted user can read is not
    // the button carrying it.
    expect(page.getByRole('button', { name: 'Place a sticker · 1 free' }).elements()).toHaveLength(
      1
    );
  });

  test('says nothing about free when the viewer has spent their placement for the day', async () => {
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 0,
    });
    await renderBar();

    // The exact state from the meeting: the creator has slots going spare and
    // the reader still may not have one.
    // `\d+ free` is the label's shape, not the whole word: unanchored `/free/i`
    // also matches wrapper elements whose subtree text contains it, and `/free$/`
    // would let a regression to "1 free left" through.
    expect(page.getByText(/\d+ free/).elements()).toHaveLength(0);
    // `exact`, because the default is a substring match — without it the bare
    // name also matches a button labelled "… · 1 free" and the assertion
    // survives the mutation it exists to catch.
    expect(
      page.getByRole('button', { name: 'Place a sticker', exact: true }).elements()
    ).toHaveLength(1);
  });

  test('says nothing about free stickers when the creator takes none', async () => {
    Object.assign(queryState, settled, {
      freeSlots: 0,
      freeSlotsRemaining: 0,
      allowanceRemaining: 1,
    });
    await renderBar();

    // `\d+ free` is the label's shape, not the whole word: unanchored `/free/i`
    // also matches wrapper elements whose subtree text contains it, and `/free$/`
    // would let a regression to "1 free left" through.
    expect(page.getByText(/\d+ free/).elements()).toHaveLength(0);
    expect(
      page.getByRole('button', { name: 'Place a sticker', exact: true }).elements()
    ).toHaveLength(1);
  });

  test('withholds the label while the allowance is still in flight', async () => {
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: undefined,
    });
    await renderBar();

    // Not "1 free", and not a promise it would have to take back: an absent
    // label becomes one, whereas a price becoming "free" is the flash this
    // ordering exists to prevent.
    // `\d+ free` is the label's shape, not the whole word: unanchored `/free/i`
    // also matches wrapper elements whose subtree text contains it, and `/free$/`
    // would let a regression to "1 free left" through.
    expect(page.getByText(/\d+ free/).elements()).toHaveLength(0);
  });

  /**
   * The shiny treatment, asserted as a difference rather than as a colour: what
   * has to be true is that an offer the reader can take looks unlike one they
   * cannot. Pinning the exact rgba would fail on a theme change that kept the
   * behaviour.
   */
  test('draws the button differently when the viewer can actually take a free one', async () => {
    // A stickered image, deliberately. On an empty one the button already wears
    // this tint as half of the "place the first one" invitation, so both renders
    // would come back identical and the test would pass for the wrong reason.
    const stickered = { ...settled, counts: { [IMAGE_ID]: 3 } };

    Object.assign(queryState, stickered, {
      freeSlots: 4,
      freeSlotsRemaining: 1,
      allowanceRemaining: 1,
    });
    await renderBar();
    const available = await backgroundOf('Place a sticker · 1 free');

    Object.assign(queryState, stickered, {
      freeSlots: 4,
      freeSlotsRemaining: 1,
      allowanceRemaining: 0,
    });
    await renderBar();
    // `exact`, because the first render is still mounted and its button is
    // named "Place a sticker · 1 free" — a substring match resolves to both and
    // fails on strict mode rather than on the property under test.
    const spent = await backgroundOf('Place a sticker', true);

    expect(available).not.toBe(spent);
  });

  /**
   * The tooltip is where the price has always lived, and now where the reason
   * lives too. Both halves are asserted per state, because "says the price" and
   * "explains which scarcity ran out" fail independently — a tooltip that quotes
   * the price and explains nothing is exactly what shipped.
   */
  /**
   * 🔴 The hint replaced a tooltip, and the difference is who can see it.
   *
   * The bar used to explain itself on hover — which meant a phone was told
   * nothing, in the states where knowing matters most. What is left is a
   * popover: on screen without a pointer, dismissable by anyone, and shown ONLY
   * where there is a free placement to take. The reasons free is unavailable
   * moved to the tray, at the point the choice is made.
   */
  test('announces a free sticker without needing a pointer', async () => {
    localStorage.removeItem('sticker-free-hint-dismissed');
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
    });
    await renderBar();

    // No hover anywhere in this test. That is the point of it.
    await expect.element(page.getByText('You have a free sticker today')).toBeInTheDocument();
  });

  test.each([
    ['the allowance is spent', { freeSlots: 4, freeSlotsRemaining: 2, allowanceRemaining: 0 }],
    ['the slot here is held', { freeSlots: 4, freeSlotsRemaining: 0, allowanceRemaining: 1 }],
    ['the creator takes none', { freeSlots: 0, freeSlotsRemaining: 0, allowanceRemaining: 1 }],
    [
      'a free one was already used here',
      { freeSlots: 4, freeSlotsRemaining: 2, allowanceRemaining: 1, usedHere: true },
    ],
  ])('says nothing at all when %s', async (_name, state) => {
    localStorage.removeItem('sticker-free-hint-dismissed');
    Object.assign(queryState, settled, state);
    await renderBar();

    // A popover that appears to tell you what you cannot have is an
    // interruption on somebody else's image.
    expect(page.getByText(/You have/).elements()).toHaveLength(0);
    // The button is still there and still opens the tray, which is where the
    // reason lives now.
    expect(page.getByRole('button', { name: /^Place a sticker/ }).elements()).toHaveLength(1);
  });

  test('stays dismissed for the day it is about', async () => {
    localStorage.removeItem('sticker-free-hint-dismissed');
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
    });
    await renderBar();

    await page.getByRole('button', { name: 'Dismiss' }).click();
    await expect.element(page.getByText('You have a free sticker today')).not.toBeInTheDocument();

    // And it does not come back on the next render, which is what "dismiss"
    // means to the person who pressed it.
    await renderBar();
    expect(page.getByText('You have a free sticker today').elements()).toHaveLength(0);
  });

  /**
   * Keyed on the UTC day rather than forever, because what it announces is
   * itself daily. A permanent dismissal would mean the free tier introduces
   * itself exactly once per person, ever — and tomorrow's allowance is news
   * again.
   */
  test("comes back once yesterday's dismissal is stale", async () => {
    localStorage.setItem('sticker-free-hint-dismissed', '2020-01-01');
    Object.assign(queryState, settled, {
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
    });
    await renderBar();

    await expect.element(page.getByText('You have a free sticker today')).toBeInTheDocument();
  });

  test('asks for the standing exactly once where the viewer can place', async () => {
    standingEnabled.length = 0;
    Object.assign(queryState, settled, {
      counts: { [IMAGE_ID]: 3 },
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
    });
    await renderBar();

    // `toEqual`, not `toContain`: the exact argument, once. `toContain` passes
    // on an array that also holds a stray `false` or `undefined`, which is the
    // shape a broken guard produces.
    expect(standingEnabled).toEqual([true]);
  });

  /**
   * 🔴 The half that makes the control above falsifiable.
   *
   * `getFreeStanding` is a protectedProcedure, so asking it for a signed-out
   * viewer is a 401 — once per page it renders on. Every other test in this file
   * is signed in, so without this one the guard is never observed being false
   * and dropping it ships green.
   *
   * Signed-out is the state driven here because it is the cheapest way to make
   * `canPlace` false; the property under test is "a bar that cannot place does
   * not ask", not anything specific to sessions.
   */
  test('does not ask for the standing of a viewer who cannot place', async () => {
    standingEnabled.length = 0;
    Object.assign(queryState, settled, {
      counts: { [IMAGE_ID]: 3 },
      freeSlots: 4,
      freeSlotsRemaining: 2,
      allowanceRemaining: 1,
      signedIn: false,
    });
    await renderBar();

    expect(standingEnabled).toEqual([false]);
    // And nothing offers them a free placement they could not claim.
    // `\d+ free` is the label's shape, not the whole word: unanchored `/free/i`
    // also matches wrapper elements whose subtree text contains it, and `/free$/`
    // would let a regression to "1 free left" through.
    expect(page.getByText(/\d+ free/).elements()).toHaveLength(0);
  });
});
