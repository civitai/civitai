import { describe, expect, it } from 'vitest';
import { allocateDraftEntitlements } from '~/components/Sticker/sticker.util';

/**
 * 🔴 THE BUG JUSTIN FOUND BY USING IT.
 *
 * With one use left, laying out two stickers made the first placeable and the
 * second ask to be bought — correct. Then deleting the FIRST left the second
 * still asking, because the reason had been frozen onto it when it was created.
 * The use had been handed back and nothing gave it to anybody.
 *
 * Entitlement is a property of the set of drafts, not of any one draft, so it is
 * recomputed from the set every time the set changes.
 */
const draft = (id: string, cosmeticId = 42) => ({ id, cosmeticId });
const owned = (remaining: number | null, cosmeticId = 42) => [{ cosmeticId, remaining }];

const coveredIds = (result: Map<string, { covered: boolean }>) =>
  [...result].filter(([, value]) => value.covered).map(([id]) => id);

describe('allocating uses across the drafts on an image', () => {
  it('covers as many drafts as there are uses, in the order they were laid down', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b'), draft('c')],
      balances: owned(2),
      freeAvailable: false,
    });

    expect(coveredIds(result)).toEqual(['a', 'b']);
  });

  /**
   * The actual report: delete the covered one and the use it was holding has to
   * move to the next draft rather than evaporating.
   */
  it('hands the use to the next draft when the covered one is deleted', () => {
    const before = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b')],
      balances: owned(1),
      freeAvailable: false,
    });
    expect(coveredIds(before)).toEqual(['a']);

    const after = allocateDraftEntitlements({
      drafts: [draft('b')],
      balances: owned(1),
      freeAvailable: false,
    });

    expect(coveredIds(after)).toEqual(['b']);
  });

  it('counts each sticker separately', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a', 42), draft('b', 42), draft('c', 99)],
      balances: [
        { cosmeticId: 42, remaining: 1 },
        { cosmeticId: 99, remaining: 1 },
      ],
      freeAvailable: false,
    });

    expect(coveredIds(result)).toEqual(['a', 'c']);
  });

  it('covers everything when the holding is unlimited', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b'), draft('c')],
      balances: owned(null),
      freeAvailable: false,
    });

    expect(coveredIds(result)).toEqual(['a', 'b', 'c']);
  });

  it('covers nothing when the uses are spent', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b')],
      balances: owned(0),
      freeAvailable: false,
    });

    expect(coveredIds(result)).toEqual([]);
  });

  /**
   * Unknown is not zero. Before the balances arrive — or for a sticker being
   * bought outright, which has no holding — this rule has nothing to say, and
   * the draft's own stored gate answers instead. Guessing "not covered" would
   * put a buy button on every draft for a frame.
   */
  it('says nothing while the balances are unknown', () => {
    const loading = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b')],
      balances: undefined,
      freeAvailable: false,
    });
    expect(coveredIds(loading)).toEqual(['a', 'b']);

    const unowned = allocateDraftEntitlements({
      drafts: [draft('a')],
      balances: [],
      freeAvailable: false,
    });
    expect(coveredIds(unowned)).toEqual(['a']);
  });
});

/**
 * The same rule, applied to the free placement — which Justin named in the same
 * breath, and for the same reason. A free placement is once per image, so
 * exactly one draft can be the free one, and it has to move when that draft goes.
 */
describe('allocating the free placement', () => {
  const freeIds = (result: Map<string, { free: boolean }>) =>
    [...result].filter(([, value]) => value.free).map(([id]) => id);

  it('offers it to exactly one draft, not all of them', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b'), draft('c')],
      balances: owned(null),
      freeAvailable: true,
    });

    expect(freeIds(result)).toEqual(['a']);
  });

  it('moves it to the next draft when the free one is deleted', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('b'), draft('c')],
      balances: owned(null),
      freeAvailable: true,
    });

    expect(freeIds(result)).toEqual(['b']);
  });

  it('offers it to nobody when there is no free placement on offer', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a')],
      balances: owned(null),
      freeAvailable: false,
    });

    expect(freeIds(result)).toEqual([]);
  });

  /**
   * A sticker still being bought outright cannot take it: it has to be paid for
   * before it can be placed at all, and that is not what free means here. The
   * offer goes to the first draft that could actually keep it.
   */
  it('skips a draft that has to be bought before it can be placed', () => {
    const result = allocateDraftEntitlements({
      drafts: [
        {
          id: 'shop',
          cosmeticId: 42,
          purchase: { pack: { shopItemId: 1, unitAmount: 5, acceptsBlue: false } },
        },
        draft('owned'),
      ],
      balances: owned(null),
      freeAvailable: true,
    });

    expect(freeIds(result)).toEqual(['owned']);
  });
});

/**
 * 🔴 THE USE BELONGS TO THE DRAFT THAT PAID FOR IT.
 *
 * Coverage is otherwise assigned in creation order, so buying a use from the
 * SECOND of two gated copies raised the balance and covered the FIRST: the
 * button that was pressed did not change, which reads as a purchase that failed
 * and invites paying again. Uses are fungible per sticker so no Buzz is lost —
 * the wrong sticker simply becomes the placeable one.
 */
describe('a draft that paid for a use gets it', () => {
  it('covers the draft that bought, not the one created first', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('first'), draft('second')],
      balances: owned(1),
      freeAvailable: false,
      paidDraftIds: ['second'],
    });

    expect(coveredIds(result)).toEqual(['second']);
  });

  it('resolves two purchases in the order they were made', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b'), draft('c')],
      balances: owned(2),
      freeAvailable: false,
      paidDraftIds: ['c', 'b'],
    });

    expect(coveredIds(result).sort()).toEqual(['b', 'c']);
  });

  it('falls back to creation order for drafts nobody paid for', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('a'), draft('b')],
      balances: owned(1),
      freeAvailable: false,
      paidDraftIds: [],
    });

    expect(coveredIds(result)).toEqual(['a']);
  });
});

/**
 * 🔴 THE FREE PLACEMENT HAS TO GO TO A DRAFT THAT CAN TAKE IT.
 *
 * Chosen before coverage, it landed on a spent owned sticker — which then
 * renders a buy button, and a draft with a gate hides the free option. Every
 * other draft was told there was no free offer, so the placer had a free
 * placement available and nowhere to spend it.
 */
describe('the free placement skips drafts that cannot use it', () => {
  const freeIds = (result: Map<string, { free: boolean }>) =>
    [...result].filter(([, value]) => value.free).map(([id]) => id);

  it('passes over an uncovered draft to one that is covered', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('spent', 42), draft('has-uses', 99)],
      balances: [
        { cosmeticId: 42, remaining: 0 },
        { cosmeticId: 99, remaining: 3 },
      ],
      freeAvailable: true,
    });

    expect(freeIds(result)).toEqual(['has-uses']);
  });

  it('offers it to nobody when every draft needs buying first', () => {
    const result = allocateDraftEntitlements({
      drafts: [draft('spent')],
      balances: owned(0),
      freeAvailable: true,
    });

    expect(freeIds(result)).toEqual([]);
  });
});
