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
  /** Optional note from the placer, shown beside their creator card on hover. */
  comment?: string;
  /**
   * The owner took the sticker and refused the note.
   *
   * A flag rather than deleting the text, because the placer paid for the
   * placement the note came with and a report has to be able to reach what was
   * actually written. Absent means never hidden, so an existing row needs no
   * backfill.
   */
  commentHidden?: boolean;
  /** Mirrored horizontally, so a sticker can face into the artwork. */
  flip: boolean;
  /** 0.3–1. Floored, never zero — see `STICKER_PLACEMENT_MIN_OPACITY`. */
  opacity: number;
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
 * How faint a placer may make their own sticker.
 *
 * The floor is the point of the setting. A near-invisible sticker is a quiet way
 * to deface someone's image, and it works against the treatment — the shadow and
 * the sway exist to make a sticker read as obviously not part of the artwork, and
 * both disappear along with it. Creator review does not cover the gap either:
 * auto-approve creators never look, and review happens on a small card where a
 * very low opacity sticker looks like nothing and then shows up at full size.
 *
 * Bounds live here and are enforced in the schema, so a crafted `0.01` is refused
 * on the way in rather than checked again at each place that draws one.
 */
export const STICKER_PLACEMENT_MIN_OPACITY = 0.3;
export const STICKER_PLACEMENT_MAX_OPACITY = 1;

/**
 * What a placement means when it does not say.
 *
 * Every row written before this existed has neither key, and they were all placed
 * at full strength and unmirrored. Applied in `parseStickerPlacementData` rather
 * than at each reader, so a surface added later cannot forget it and draw a
 * transparent sticker.
 */
export const STICKER_PLACEMENT_DEFAULT_OPACITY = 1;

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
  flip: data.flip === true,
  // Defaulted before it is clamped, because `clamp(undefined)` is NaN and this is
  // reached by callers the schema's default never passed through — a stored row
  // on its way through `parseStickerPlacementData`, and anything hand-written.
  // NaN would be written to the row and drawn as no sticker at all.
  opacity: clamp(
    Number.isFinite(data.opacity) ? data.opacity : STICKER_PLACEMENT_DEFAULT_OPACITY,
    STICKER_PLACEMENT_MIN_OPACITY,
    STICKER_PLACEMENT_MAX_OPACITY
  ),
});

/**
 * Long enough for a joke or a compliment, short enough that it cannot become a
 * comment thread nobody can moderate. It sits on a hover card beside a creator
 * card, so anything longer stops fitting before it stops being allowed.
 */
export const STICKER_COMMENT_MAX_LENGTH = 300;

/**
 * Truncated rather than refused, and whitespace-collapsed on the way through.
 *
 * A note is optional decoration on a payment that has already been quoted, so
 * failing the placement over a long one would cost the placer a round trip
 * through a Buzz charge for something the field can simply hold less of. The
 * schema still bounds it; this is what makes the stored value canonical however
 * it arrived — a hand-written API call, a paste with newlines in it, an
 * all-spaces string that would otherwise render as an empty comment bubble.
 */
export const normalizeStickerComment = (comment?: string | null): string | undefined => {
  if (typeof comment !== 'string') return undefined;
  const collapsed = comment.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed.slice(0, STICKER_COMMENT_MAX_LENGTH) : undefined;
};

/**
 * How long an approved sticker is protected from the owner removing it.
 *
 * Approval pays the owner immediately and nothing is refunded on removal, so
 * without this an owner could accept a sticker, bank the Buzz and wipe it before
 * anyone saw it — which is indistinguishable from an honest removal and costs
 * the placer everything they paid. Deliberately the same week the remix gallery
 * uses; they are the same bargain on two surfaces, and two numbers would drift.
 *
 * A moderator is not bound by it: a takedown is a moderation record, not an
 * owner decision, and the abusive cases are the ones that must not wait.
 */
export const STICKER_REMOVAL_LOCK_HOURS = 24 * 7;

/** When a sticker approved at `approvedAt` may be removed by the content owner. */
export const stickerRemovableAt = (approvedAt: Date | string) =>
  new Date(new Date(approvedAt).getTime() + STICKER_REMOVAL_LOCK_HOURS * 60 * 60 * 1000);

/**
 * `opacity` and `flip` are deliberately not required. Rows written before they
 * existed carry neither, and demanding them here would drop every one of those
 * placements from the surfaces that filter on this.
 */
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
 * A stored placement, with the keys it may not have.
 *
 * How every surface that DRAWS a placement reads `Placement.data`. Readers used
 * to cast the JSON straight to `StickerPlacementData`, which types a key as
 * present that a row can simply not have — so a missing `opacity` reached a
 * style as `undefined` and drew nothing. Clamped as well as defaulted, because
 * this is JSON on a row: a hand-edit or a backfill reaches it without passing the
 * schema, and a stored `0` would be an invisible sticker that is still clickable.
 *
 * Not every reader: `hideStickerComment` deliberately keeps the raw payload,
 * because it writes the row back, and a write path that normalises would edit
 * geometry as a side effect of hiding a note. Only a hand-seeded out-of-bounds
 * row could actually move today — the schema and the clamp share their limits —
 * so this is about which path is allowed to rewrite a stored value.
 */
export const parseStickerPlacementData = (value: unknown): StickerPlacementData | null => {
  if (!isStickerPlacementData(value)) return null;
  const data = value as Record<string, unknown>;

  return {
    // Spread first so the geometry below is authoritative: this carries the note
    // and its hidden flag through untouched — they are text, not geometry, and
    // normalising them here would strip them off every row that has one.
    ...(data as Partial<StickerPlacementData>),
    cosmeticId: data.cosmeticId as number,
    ...normalizeStickerPlacement({
      x: data.x as number,
      y: data.y as number,
      scale: data.scale as number,
      rotation: data.rotation as number,
      flip: data.flip === true,
      opacity: data.opacity as number,
    }),
  };
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
