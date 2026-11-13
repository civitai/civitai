/** A sticker with no `uses` is unlimited; with `uses`, each purchase is a row holding that many. */
export const stickerUses = (data: unknown): number | null => {
  const uses = (data as { uses?: unknown } | null)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};

export const cosmeticImageKey = (data: unknown): string | null => {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url ? url : null;
};

/** Everything but a sticker is bought once; a sticker is bought again for more uses until a holding is unlimited. */
export function holdingBlocksPurchase(
  type: string,
  held: { remaining: number | null }[]
): 'owned' | 'unlimited' | null {
  if (type === 'Sticker') return held.some((row) => row.remaining === null) ? 'unlimited' : null;
  return held.length > 0 ? 'owned' : null;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export type NameplateGradient = { from: string; to: string; deg: number };

/** A gradient nameplate's colors and angle, or null when its data is anything but well-formed. */
export function nameplateGradient(data: unknown): NameplateGradient | null {
  const value = data as { variant?: unknown; gradient?: Record<string, unknown> } | null;
  const gradient = value?.gradient;
  if (value?.variant !== 'gradient' || !gradient || typeof gradient !== 'object') return null;
  const { from, to, deg } = gradient;
  if (typeof from !== 'string' || !HEX_COLOR.test(from)) return null;
  if (typeof to !== 'string' || !HEX_COLOR.test(to)) return null;
  if (typeof deg !== 'number' || !Number.isFinite(deg)) return null;
  return { from, to, deg };
}

export type FrameOffsets = { top: number; left: number; right: number; bottom: number };

/** An avatar frame's per-side offsets (pixels at a 96px avatar), or null unless all four are numbers. */
export function frameOffsets(data: unknown): FrameOffsets | null {
  const offsets = (data as { offsets?: Record<string, unknown> } | null)?.offsets;
  if (!offsets || typeof offsets !== 'object') return null;
  const sides = ['top', 'left', 'right', 'bottom'] as const;
  if (!sides.every((side) => typeof offsets[side] === 'number' && Number.isFinite(offsets[side])))
    return null;
  const { top, left, right, bottom } = offsets as FrameOffsets;
  return { top, left, right, bottom };
}
