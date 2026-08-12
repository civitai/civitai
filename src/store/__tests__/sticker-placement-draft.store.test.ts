import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectedDraft,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

const IMAGE = 101;
const OTHER_IMAGE = 202;
const COSMETIC = 7;
const OTHER_COSMETIC = 8;

const state = () => useStickerPlacementDraftStore.getState();

/** Open the panel and lay `count` stickers down, which is the interesting state. */
const withDrafts = (count = 1, cosmeticId = COSMETIC) => {
  state().open(IMAGE);
  for (let i = 0; i < count; i++) state().begin(cosmeticId);
  expect(state().drafts, 'setup did not produce the drafts it meant to').toHaveLength(count);
};

describe('sticker placement draft store', () => {
  beforeEach(() => {
    useStickerPlacementDraftStore.setState({
      drafts: [],
      selectedDraftId: null,
      targetImageId: null,
      trayOpen: false,
      surface: null,
      tray: null,
      interaction: null,
    });
  });

  describe('several at once', () => {
    // Dragging a second sticker out used to delete the first, which made
    // arranging a few and then choosing between them impossible.
    it('keeps the earlier stickers when another is dragged out', () => {
      withDrafts(3);

      expect(state().drafts).toHaveLength(3);
    });

    it('gives each draft its own identity, so the same sticker can be laid twice', () => {
      withDrafts(2);

      const [first, second] = state().drafts;
      expect(first.cosmeticId).toBe(second.cosmeticId);
      expect(first.id).not.toBe(second.id);
    });

    it('selects the one just dragged out, which is the one the drag is moving', () => {
      withDrafts(2);

      expect(state().selectedDraftId).toBe(state().drafts[1].id);
    });

    // The handles, the knob, the remove badge and the buy button all belong to
    // the selection. Leaving it empty while drafts remain strands them: nothing
    // to drag, and no way to remove the next one.
    it('never leaves the selection empty while any draft remains', () => {
      withDrafts(3);
      const [first, , third] = state().drafts;

      state().cancelDraft(third.id);
      expect(selectedDraft(state())).not.toBeNull();

      state().cancelDraft(state().selectedDraftId!);
      expect(selectedDraft(state())?.id).toBe(first.id);
    });

    it('leaves the selection alone when some other draft is removed', () => {
      withDrafts(3);
      const [first, , third] = state().drafts;
      state().select(third.id);

      state().cancelDraft(first.id);

      expect(state().selectedDraftId).toBe(third.id);
    });

    it('moves the draft it is given rather than whichever is selected', () => {
      withDrafts(2);
      const [first, second] = state().drafts;

      state().move(first.id, { x: 0.1 });

      expect(state().drafts.find((draft) => draft.id === first.id)?.x).toBe(0.1);
      expect(state().drafts.find((draft) => draft.id === second.id)?.x).toBe(0.5);
    });

    // Order is draw order. Reordering on move would make a sticker jump over its
    // neighbours mid-drag.
    it('keeps draft order across a move', () => {
      withDrafts(3);
      const ids = state().drafts.map((draft) => draft.id);

      state().move(ids[0], { x: 0.2 });

      expect(state().drafts.map((draft) => draft.id)).toEqual(ids);
    });

    it('ignores a move for a draft that is already gone', () => {
      withDrafts(1);
      const [only] = state().drafts;
      state().cancelDraft(only.id);

      expect(() => state().move(only.id, { x: 0.9 })).not.toThrow();
    });
  });

  describe('the panel and the session', () => {
    // The panel is fixed to the bottom of the viewport, so it covers the part of
    // the image a sticker aimed low has to land on. Putting it away has to be
    // possible without losing the stickers.
    it('keeps the drafts when the panel is put away', () => {
      withDrafts(2);

      state().closeTray();

      expect(state().drafts).toHaveLength(2);
      expect(state().trayOpen).toBe(false);
      // The layer that draws the drafts and the surface every drag is measured
      // against are both gated on this. Losing it unmounts them as surely as
      // clearing the drafts would.
      expect(state().targetImageId).toBe(IMAGE);
    });

    it('ends the session when the panel is put away with nothing placed', () => {
      state().open(IMAGE);

      state().closeTray();

      expect(state().targetImageId).toBeNull();
      expect(state().trayOpen).toBe(false);
    });

    it('gets back to the panel without losing the stickers', () => {
      withDrafts(2);
      state().closeTray();

      state().open(IMAGE);

      expect(state().trayOpen).toBe(true);
      expect(state().drafts).toHaveLength(2);
    });

    it('does not carry drafts onto a different image', () => {
      withDrafts(2);

      state().open(OTHER_IMAGE);

      expect(state().drafts).toHaveLength(0);
      expect(state().targetImageId).toBe(OTHER_IMAGE);
    });

    it('discards one draft but keeps the panel, so another sticker can be chosen', () => {
      withDrafts(1);

      state().cancelDraft(state().drafts[0].id);

      expect(state().drafts).toHaveLength(0);
      expect(state().trayOpen).toBe(true);
      expect(state().targetImageId).toBe(IMAGE);
    });

    // Cancelling from the sticker's own badge with the panel already away leaves
    // nothing on screen. Holding the session open there would keep the image in
    // placement mode — still revealing pending placements, still holding the
    // surface — with no visible control that would end it.
    it('ends the session when the last draft goes with the panel already away', () => {
      withDrafts(2);
      state().closeTray();

      state().cancelDraft(state().drafts[0].id);
      expect(state().targetImageId, 'ended while a draft was still on the image').toBe(IMAGE);

      state().cancelDraft(state().drafts[0].id);
      expect(state()).toMatchObject({ targetImageId: null, trayOpen: false, drafts: [] });
    });

    it('ends everything on close', () => {
      withDrafts(2);

      state().close();

      expect(state()).toMatchObject({
        drafts: [],
        selectedDraftId: null,
        targetImageId: null,
        trayOpen: false,
        interaction: null,
      });
    });

    it('will not start a draft with no image targeted', () => {
      state().begin(COSMETIC);

      expect(state().drafts).toHaveLength(0);
    });
  });

  // `useCreateStickerPlacement` removes the bought draft rather than ending the
  // session. Ending it would take the drafts still being arranged with it; and
  // leaving the bought one would draw the same sticker twice, once as the real
  // placement and once as an uncommitted draft on top of it.
  it('leaves the other drafts alone when one is bought', () => {
    withDrafts(2);
    state().begin(OTHER_COSMETIC);
    const bought = state().drafts[1];

    state().cancelDraft(bought.id);

    expect(state().drafts).toHaveLength(2);
    expect(state().drafts.map((draft) => draft.id)).not.toContain(bought.id);
    expect(state().targetImageId).toBe(IMAGE);
  });
});
