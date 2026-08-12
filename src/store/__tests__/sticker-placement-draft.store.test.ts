import { beforeEach, describe, expect, it } from 'vitest';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

const IMAGE = 101;
const OTHER_IMAGE = 202;
const COSMETIC = 7;

const state = () => useStickerPlacementDraftStore.getState();

/** Open the panel and get a sticker onto the image, which is the interesting state. */
const withDraft = (imageId = IMAGE) => {
  state().open(imageId);
  state().begin(COSMETIC);
  expect(state().draft, 'setup failed to produce a draft').not.toBeNull();
};

describe('sticker placement draft store', () => {
  beforeEach(() => {
    useStickerPlacementDraftStore.setState({
      draft: null,
      targetImageId: null,
      trayOpen: false,
      surface: null,
      tray: null,
      interaction: null,
    });
  });

  // The panel is fixed to the bottom of the viewport, so it covers the part of
  // the image a sticker aimed low has to land on. Putting it away has to be
  // possible without losing the sticker, which is the whole point of separating
  // `trayOpen` from `targetImageId`.
  it('keeps the draft when the panel is put away', () => {
    withDraft();

    state().closeTray();

    expect(state().draft).toMatchObject({ imageId: IMAGE, cosmeticId: COSMETIC });
    expect(state().trayOpen).toBe(false);
    // The layer that draws the draft and the surface every drag is measured
    // against are both gated on this. Losing it unmounts the sticker as surely
    // as clearing the draft would.
    expect(state().targetImageId).toBe(IMAGE);
  });

  it('ends the session when the panel is put away with nothing placed', () => {
    state().open(IMAGE);

    state().closeTray();

    expect(state().targetImageId).toBeNull();
    expect(state().trayOpen).toBe(false);
  });

  it('gets back to the panel without losing the sticker', () => {
    withDraft();
    state().closeTray();

    state().open(IMAGE);

    expect(state().trayOpen).toBe(true);
    expect(state().draft).toMatchObject({ cosmeticId: COSMETIC });
  });

  it('does not carry a draft onto a different image', () => {
    withDraft();

    state().open(OTHER_IMAGE);

    expect(state().draft).toBeNull();
    expect(state().targetImageId).toBe(OTHER_IMAGE);
  });

  it('discards the draft but keeps the panel, so another sticker can be chosen', () => {
    withDraft();

    state().cancelDraft();

    expect(state().draft).toBeNull();
    expect(state().trayOpen).toBe(true);
    expect(state().targetImageId).toBe(IMAGE);
  });

  // Cancelling from the sticker's own badge with the panel already away leaves
  // nothing on screen. Holding the session open there would keep the image in
  // placement mode — still revealing pending placements, still holding the
  // surface — with no visible control that would end it.
  it('ends the session when the draft is discarded with the panel already away', () => {
    withDraft();
    state().closeTray();

    state().cancelDraft();

    expect(state()).toMatchObject({ draft: null, targetImageId: null, trayOpen: false });
  });

  // `useCreateStickerPlacement` calls this on a successful purchase. If it only
  // put the panel away, the draft would stay on the image on top of the real
  // placement it just became — the same sticker drawn twice, one of them
  // uncommitted.
  it('ends everything on close, which is what a completed purchase calls', () => {
    withDraft();

    state().close();

    expect(state()).toMatchObject({
      draft: null,
      targetImageId: null,
      trayOpen: false,
      interaction: null,
    });
  });

  it('will not start a draft with no image targeted', () => {
    state().begin(COSMETIC);

    expect(state().draft).toBeNull();
  });
});
