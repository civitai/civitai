import { beforeEach, describe, expect, it } from 'vitest';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * Duplicating a sticker makes a DRAFT and nothing else.
 *
 * That is the whole safety argument for this feature. Placement is charged, and
 * the allowance behind it is not simple — one free placement per person per day,
 * shared with remix galleries, plus a once-ever free slot per image. A second
 * route into the charge path would have to reproduce every one of those guards
 * and would be wrong the day one of them moved.
 *
 * So there is no second route: a duplicate is an unplaced draft, bought and
 * committed by the same button and the same mutation as the first one. What is
 * asserted here is that copying places nothing and charges nothing — and that
 * the copy carries the purchase gate the CALLER decided on, rather than
 * inheriting the original's, which is a fact about inventory at the moment the
 * copy was made rather than a property of the draft.
 */
const purchase = {
  pack: { shopItemId: 7, unitAmount: 500, acceptsBlue: false },
  creatorUsername: 'maker',
};

const store = () => useStickerPlacementDraftStore.getState();
const drafts = () => store().drafts;

describe('duplicating a draft', () => {
  beforeEach(() => {
    store().close();
    store().open(1);
    store().begin(42, { x: 0.4, y: 0.5 }, 0.4);
    store().move(drafts()[0].id, { rotation: 12, scale: 0.3, flip: true, opacity: 0.6 });
  });

  it('copies the arrangement, which is the point of copying rather than picking up', () => {
    const original = drafts()[0];
    store().duplicateDraft(original.id);

    const copy = drafts()[1];
    expect(copy).toMatchObject({
      cosmeticId: original.cosmeticId,
      imageId: original.imageId,
      rotation: 12,
      scale: 0.3,
      flip: true,
      opacity: 0.6,
    });
  });

  it('is its own draft, not a second reference to the first', () => {
    const original = drafts()[0];
    store().duplicateDraft(original.id);

    expect(drafts()).toHaveLength(2);
    expect(drafts()[1].id).not.toBe(original.id);

    // Moving the copy must not move the original, which a shared id would.
    store().move(drafts()[1].id, { rotation: -30 });
    expect(drafts()[0].rotation).toBe(12);
  });

  it('lands beside the original rather than exactly on top of it', () => {
    const original = drafts()[0];
    store().duplicateDraft(original.id);

    const copy = drafts()[1];
    expect(copy.x).toBeGreaterThan(original.x);
    expect(copy.y).toBeGreaterThan(original.y);
  });

  /**
   * A duplicate of a sticker already at the far edge would otherwise be offset
   * off the image, where it cannot be seen or dragged back — and where the
   * server refuses the placement for a position outside the bounds.
   */
  it('stays on the image when the original is at the edge', () => {
    store().move(drafts()[0].id, { x: 1, y: 1 });
    store().duplicateDraft(drafts()[0].id);

    expect(drafts()[1]).toMatchObject({ x: 1, y: 1 });
  });

  it('selects the copy, because that is the one being positioned now', () => {
    store().duplicateDraft(drafts()[0].id);

    expect(store().selectedDraftId).toBe(drafts()[1].id);
  });

  it('does nothing at all for an id that is not there', () => {
    store().duplicateDraft('not-a-draft');

    expect(drafts()).toHaveLength(1);
  });

  describe('the purchase gate is the caller’s decision, not the original’s', () => {
    it('gates the copy when the caller says it must be bought', () => {
      store().duplicateDraft(drafts()[0].id, purchase);

      expect(drafts()[1].purchase).toEqual(purchase);
    });

    /**
     * 🔴 The one that would sell the same use twice. The original was dragged out
     * of the shop and is still unbought; by the time the copy is made the caller
     * has seen a use available and passes nothing. Cloning the original's gate
     * here would put a second buy button on a sticker that needs buying once.
     */
    it('does not inherit the original’s gate when the caller passes none', () => {
      store().close();
      store().open(1);
      store().begin(42, { x: 0.4, y: 0.5 }, 0.4, purchase);
      expect(drafts()[0].purchase).toEqual(purchase);

      store().duplicateDraft(drafts()[0].id);

      expect(drafts()[1].purchase).toBeUndefined();
    });

    /**
     * The opposite direction, and the one that matters for money: the original
     * was placed with a use the placer had, the copy needs another and there is
     * none left. The caller sees that and hands over the top-up offer.
     */
    it('gates a copy of an ungated draft when the uses have run out', () => {
      expect(drafts()[0].purchase).toBeUndefined();

      store().duplicateDraft(drafts()[0].id, { ...purchase, refill: true });

      expect(drafts()[1].purchase).toMatchObject({ refill: true });
    });
  });

  it('places nothing and charges nothing — it only adds a draft', () => {
    const before = drafts().length;
    store().duplicateDraft(drafts()[0].id);

    // The only observable effect is one more unplaced draft. Nothing here can
    // reach the mutation: the store holds no network client at all.
    expect(drafts()).toHaveLength(before + 1);
    expect(drafts().every((draft) => draft.imageId === 1)).toBe(true);
  });
});
