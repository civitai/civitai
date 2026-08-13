import { describe, expect, it } from 'vitest';
import { stickerPlacementDataSchema } from '~/server/schema/placement.schema';
import { stickerArtworkStyle } from '~/components/Sticker/placement-appearance';
import {
  normalizeStickerPlacement,
  parseStickerPlacementData,
  STICKER_PLACEMENT_MIN_OPACITY,
} from '~/shared/utils/sticker-placement';

/**
 * The placer's own two settings, and the floor under one of them.
 *
 * The floor is not a display preference: a near-invisible sticker is a quiet way
 * to deface someone's image, it survives an auto-approving creator, and at review
 * size it looks like nothing and then shows up full-strength. So the refusal is
 * checked at the schema — the only boundary a crafted request has to cross — and
 * the clamp is checked at the parse, which is what a row edited by hand reaches.
 */

const LEGACY = { cosmeticId: 900, x: 0.5, y: 0.5, scale: 0.2, rotation: 15 };

describe('the opacity floor', () => {
  it('refuses a value under the floor at the schema, rather than clamping it', () => {
    const result = stickerPlacementDataSchema.safeParse({ ...LEGACY, opacity: 0.05 });

    expect(result.success).toBe(false);
  });

  it('accepts the floor itself', () => {
    const result = stickerPlacementDataSchema.safeParse({
      ...LEGACY,
      opacity: STICKER_PLACEMENT_MIN_OPACITY,
    });

    expect(result.success).toBe(true);
  });

  // A client cached from before these existed sends neither key. It must still
  // place a sticker, at full strength, rather than fail validation.
  it('defaults both keys when a request omits them', () => {
    const result = stickerPlacementDataSchema.parse(LEGACY);

    expect(result.opacity).toBe(1);
    expect(result.flip).toBe(false);
  });

  // The schema is the boundary, not the only guard: `data` is JSON on a row, so a
  // backfill or a hand-edit reaches the readers without passing through it. A
  // stored 0 would be a sticker that is invisible and still clickable.
  it('clamps a stored value that never passed the schema', () => {
    expect(parseStickerPlacementData({ ...LEGACY, opacity: 0 })?.opacity).toBe(
      STICKER_PLACEMENT_MIN_OPACITY
    );
  });
});

describe('reading a stored placement', () => {
  it('fills the defaults for a row written before these existed', () => {
    const parsed = parseStickerPlacementData(LEGACY);

    expect(parsed).toMatchObject({ opacity: 1, flip: false, rotation: 15 });
  });

  it('does not drop a legacy row for missing keys', () => {
    expect(parseStickerPlacementData(LEGACY)).not.toBeNull();
  });

  it('still refuses a row with no usable position', () => {
    expect(parseStickerPlacementData({ ...LEGACY, x: 'left' })).toBeNull();
  });

  // `clamp(undefined, …)` is NaN, which serialises to null and draws nothing.
  // The write path defaults before it clamps for exactly this reason.
  it('never produces a NaN opacity from an absent one', () => {
    const normalized = normalizeStickerPlacement({
      x: 0.5,
      y: 0.5,
      scale: 0.2,
      rotation: 0,
      flip: false,
    } as Parameters<typeof normalizeStickerPlacement>[0]);

    expect(Number.isFinite(normalized.opacity)).toBe(true);
    expect(normalized.opacity).toBe(1);
  });

  it('treats a non-boolean flip as unflipped rather than truthy', () => {
    expect(parseStickerPlacementData({ ...LEGACY, flip: 'yes' })?.flip).toBe(false);
  });
});

describe('what the placer chooses, as styles', () => {
  // Opacity rides on the artwork, whose shadow and die-cut edge are its own
  // filter, so the two fade together — a full-strength shadow under faint artwork
  // reads as a rendering fault. The sway is a wrapper and is untouched: motion is
  // the cue that a faint sticker is still a sticker.
  it('mirrors the artwork alone, and only when flipped', () => {
    expect(stickerArtworkStyle({ flip: true, opacity: 1 }).transform).toBe('scaleX(-1)');
    expect(stickerArtworkStyle({ flip: false, opacity: 1 }).transform).toBeUndefined();
  });

  it('carries the opacity through unchanged', () => {
    expect(stickerArtworkStyle({ flip: false, opacity: 0.3 }).opacity).toBe(0.3);
  });
});
