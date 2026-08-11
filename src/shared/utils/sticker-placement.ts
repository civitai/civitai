/**
 * Where a sticker sits on a piece of content, and how big it is.
 *
 * **Relative to the bounds of the target, never in pixels.** The same image is
 * drawn at a card width in a feed and at full width in the detail view, and a
 * pixel offset would put the sticker somewhere different in each. `x`/`y` are
 * fractions of width and height; `scale` is a fraction of the target's *width*
 * only, so an overlay keeps its proportions instead of stretching with the
 * aspect ratio of whatever it sits on.
 *
 * Zero imports on purpose, like `sticker-token.ts` — schemas and pure tests use
 * this without dragging a service graph in behind it.
 */
export type StickerPlacementData = {
  cosmeticId: number;
  /** 0–1, fraction of the target's width. The sticker's centre, not its corner. */
  x: number;
  /** 0–1, fraction of the target's height. */
  y: number;
  /** Fraction of the target's width. Bounded below and above. */
  scale: number;
  /** Degrees, for a sticker placed at an angle. */
  rotation: number;
};

/**
 * A sticker may be resized within a maximum. Justin considered charging by size
 * and talked himself out of it — *"I don't think we need to go that far"* — so
 * these are display bounds only and nothing here reaches the price.
 *
 * The ceiling is what stops a placement being a defacement: at 40% of the width
 * a sticker is an accent, and a creator who accepted one has not accepted having
 * their work covered.
 */
export const STICKER_PLACEMENT_MIN_SCALE = 0.05;
export const STICKER_PLACEMENT_MAX_SCALE = 0.4;
export const STICKER_PLACEMENT_DEFAULT_SCALE = 0.18;

export const STICKER_PLACEMENT_MAX_ROTATION = 180;

/**
 * What a creator's space allows by default, when they have never set a max.
 *
 * Tighter than the absolute ceiling on purpose: most creators will never open
 * this setting, and the default is what the feature actually feels like. They
 * can raise it to `STICKER_PLACEMENT_MAX_SCALE` or lower it to the floor.
 */
export const STICKER_PLACEMENT_DEFAULT_MAX_SCALE = 0.25;

/**
 * The largest a sticker may be placed on this space.
 *
 * Clamped into the global bounds rather than trusted. Validating on write would
 * be the usual answer, and there is a schema doing that — but this is JSON on a
 * row, so it has no boundary to validate at: a support fix, a hand-edit or a
 * migration written at speed all reach it without passing the schema. A stored
 * `5` would otherwise mean a sticker five times the width of the image.
 */
export function stickerMaxScale(settings?: Record<string, unknown> | null) {
  const stored = settings?.[STICKER_MAX_SCALE_KEY];
  if (typeof stored !== 'number' || !Number.isFinite(stored))
    return STICKER_PLACEMENT_DEFAULT_MAX_SCALE;
  return Math.min(Math.max(stored, STICKER_PLACEMENT_MIN_SCALE), STICKER_PLACEMENT_MAX_SCALE);
}

export const STICKER_MAX_SCALE_KEY = 'maxScale';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Clamped rather than rejected, because these arrive from a drag: a pointer that
 * leaves the image by a pixel is a normal gesture, not a malformed request. The
 * schema still refuses anything non-finite — a NaN would render nowhere and be
 * indistinguishable from the sticker not existing.
 */
export const normalizeStickerPlacement = (
  data: Omit<StickerPlacementData, 'cosmeticId'>
): Omit<StickerPlacementData, 'cosmeticId'> => ({
  x: clamp(data.x, 0, 1),
  y: clamp(data.y, 0, 1),
  scale: clamp(data.scale, STICKER_PLACEMENT_MIN_SCALE, STICKER_PLACEMENT_MAX_SCALE),
  rotation: clamp(data.rotation, -STICKER_PLACEMENT_MAX_ROTATION, STICKER_PLACEMENT_MAX_ROTATION),
});

export const isStickerPlacementData = (value: unknown): value is StickerPlacementData => {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.cosmeticId === 'number' &&
    ['x', 'y', 'scale', 'rotation'].every(
      (key) => typeof data[key] === 'number' && Number.isFinite(data[key] as number)
    )
  );
};

/**
 * Whether the money behind a placement actually moved.
 *
 * **Never read `Placement.status` for this.** It records that a placement was
 * *processed*; only the ledger records whether the money moved, and the two can
 * legitimately disagree — a payout leg can exhaust its retries with Buzz still
 * parked in escrow while the row reads a clean `approved`.
 */
export type PlacementSettlementState =
  /** No money was due, or every leg carries a receipt. */
  | 'settled'
  /** Legs are planned and unpaid, and still being retried. */
  | 'pending'
  /** A leg gave up. Somebody is owed and nothing will pay them without a human. */
  | 'stalled';
