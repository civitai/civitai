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
    // arranging a few and then choosing between them impossible. Asserted on
    // identity rather than on length: `withDrafts` already checks the count, so
    // a length assertion here could not fail if setup passed.
    it('keeps the earlier stickers when another is dragged out', () => {
      state().open(IMAGE);
      state().begin(COSMETIC);
      const first = state().drafts[0].id;

      state().begin(OTHER_COSMETIC);

      expect(state().drafts).toHaveLength(2);
      expect(state().drafts[0].id).toBe(first);
      expect(state().drafts[0].cosmeticId).toBe(COSMETIC);
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

    // `interaction` mirrors whether the layer holds a live gesture, and only the
    // layer may write it — the tray reads it to decide whether a pickup is
    // allowed. Clearing it here said "nothing is being dragged" while a finger
    // still was, which let a pickup through that the layer then refused to arm:
    // the new sticker landed on the image and never followed the pointer.
    // Reachable with two fingers — drag one sticker, tap another's remove badge.
    it('does not report the drag as over when a different draft is removed', () => {
      withDrafts(2);
      const [first, second] = state().drafts;
      useStickerPlacementDraftStore.setState({ interaction: 'move' });

      state().cancelDraft(second.id);

      expect(state().interaction, 'removing a draft ended a drag it does not own').toBe('move');
      expect(state().drafts.map((draft) => draft.id)).toEqual([first.id]);
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

    // A gesture can outlive its draft — the remove badge is reachable mid-drag.
    // `not.toThrow()` alone would pass for a guard that returned a corrupted
    // list, so the surviving draft is checked too.
    it('ignores a move for a draft that is already gone', () => {
      withDrafts(2);
      const [first, second] = state().drafts;
      state().cancelDraft(first.id);

      expect(() => state().move(first.id, { x: 0.9 })).not.toThrow();
      expect(state().drafts.map((draft) => draft.id)).toEqual([second.id]);
      expect(state().drafts[0].x).toBe(0.5);
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

    // A tray pickup hands the drag to the layer through `interaction` plus the
    // pointer holding it. If the layer unmounts between that handoff and the
    // pointerup — the overlay stops rendering at zero width, which a resize can
    // do — nothing clears the pair, and the layer arms a phantom drag on the
    // selected sticker the moment it remounts: it follows the bare cursor with
    // no button held.
    //
    // The tray shape specifically, which is why the fixture sets a pointer id.
    // An on-image drag strands as `{'move', null}`, and the layer's arming
    // effect already refuses that for want of a pointer id — so this is the
    // shape the clear is actually needed for.
    it('clears a stranded interaction when the panel is reopened', () => {
      withDrafts(1);
      state().closeTray();
      useStickerPlacementDraftStore.setState({ interaction: 'move', interactionPointerId: 3 });

      state().open(IMAGE);

      expect(state().interaction).toBeNull();
      expect(state().interactionPointerId).toBeNull();
      expect(state().drafts, 'reopening the same image dropped the drafts').toHaveLength(1);
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

  // ⚠️ What is NOT covered here, stated so a green run is not over-read.
  //
  // `useCreateStickerPlacement`'s `onSuccess` — which decides that a purchase
  // removes one draft instead of ending the session, and which invalidates the
  // sticker-use balance — is a React hook with one caller, `DraftSticker`, and
  // neither has a test. Reverting either of those decisions fails nothing in
  // this file: these tests drive the store directly, and the store is not where
  // that choice lives. An earlier version of this file claimed otherwise in a
  // comment; the comment was the only thing connecting them.
});
