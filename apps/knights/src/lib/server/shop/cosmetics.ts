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

/** How an avatar frame sits around the avatar: per-side pixel offsets at a 96px avatar, or the legacy uniform offset string. */
export type FrameFit =
  | { kind: 'offsets'; top: number; left: number; right: number; bottom: number }
  | { kind: 'offset'; value: string };

/** Beyond this a frame would sit far outside or inside the avatar: treated as broken data, not a design. */
const MAX_FRAME_OFFSET = 50;
// The same shape the main site's `decorationFrameStyle` accepts for the legacy `offset`.
const LEGACY_OFFSET = /^-?\d+(\.\d+)?(px|%)$/;

/** An avatar frame's fit, or null when its data is incomplete, malformed or out of range. Per-side offsets win, as on the main site. */
export function frameFit(data: unknown): FrameFit | null {
  const value = data as { offsets?: unknown; offset?: unknown } | null;
  const offsets = value?.offsets as Record<string, unknown> | undefined;
  if (offsets && typeof offsets === 'object') {
    const sides = ['top', 'left', 'right', 'bottom'] as const;
    const ok = sides.every((side) => {
      const n = offsets[side];
      return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_FRAME_OFFSET;
    });
    if (!ok) return null;
    const { top, left, right, bottom } = offsets as Record<(typeof sides)[number], number>;
    return { kind: 'offsets', top, left, right, bottom };
  }
  const offset = value?.offset;
  if (typeof offset !== 'string' || !LEGACY_OFFSET.test(offset)) return null;
  return Math.abs(parseFloat(offset)) <= MAX_FRAME_OFFSET ? { kind: 'offset', value: offset } : null;
}
