import { MediaType } from '~/shared/utils/prisma/enums';
import { env } from '~/env/client';
import { isDefined } from '~/utils/type-guards';

/**
 * Pure, React-free edge-URL construction.
 *
 * Split out of `cf-images-utils.ts` so a **server** module can resolve a delivery URL
 * without dragging React client modules (`useCurrentUser`, `BrowserSettingsProvider`)
 * into its import graph. `cf-images-utils` re-exports everything here, so every existing
 * consumer is unaffected; the React hooks (`useEdgeUrl`, `useGetEdgeUrl`) stay there.
 *
 * Nothing in this file may import React, a hook, or a provider.
 */

// from options available in CF Flexible variants:
// https://developers.cloudflare.com/images/cloudflare-images/transform/flexible-variants/
export type EdgeUrlProps = {
  src: string;
  name?: string | null;
  width?: number | null;
  height?: number | null;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
  anim?: boolean;
  blur?: number; // 0-250
  quality?: number; // 0-100
  gravity?: 'auto' | 'side' | 'left' | 'right' | 'top' | 'bottom';
  metadata?: 'keep' | 'copyright' | 'none';
  background?: string;
  gamma?: number;
  optimized?: boolean;
  transcode?: boolean;
  type?: MediaType;
  original?: boolean;
  skip?: number;
  /**
   * The stored image's own width. Only used to bound the hi-DPI `srcSet` candidate — never emitted
   * into the URL. Without it a 2x candidate can ask for more pixels than the source has.
   */
  sourceWidth?: number | null;
};

const typeExtensions: Record<MediaType, string> = {
  image: '.jpeg',
  video: '.mp4',
  audio: '.mp3',
};

// Discrete width ladder mirroring civitai-image-cacher's `ImageCacherOptions.CommonSizes`
// (see appsettings.json in civitai-image-cacher). The cacher already snaps requested
// widths up to the next ladder value server-side, but only AFTER admitting the unique
// URL into its cache — costing one B2 Class C HEAD per unique width. By snapping
// client-side to the same ladder we collapse cache cardinality before emission.
//
// Must stay in sync with the deployed cacher's CommonSizes. If the values diverge,
// the snap simply becomes less effective (no correctness impact) — the cacher's
// server-side snap remains the source of truth.
export const COMMON_IMAGE_WIDTHS = [96, 320, 450, 512, 800, 1200, 1600, 2200] as const;

/** What a viewer is served while browsing. Persisted as `'optimized' | 'metadata'`. */
export type MediaQuality = 'compressed' | 'lossless';

/**
 * The viewer's effective quality.
 *
 * Compressed unless the viewer both chose lossless and is entitled to it, so an unset
 * preference — 99% of accounts — reads as compressed without anything being written. A
 * non-member's stored `'metadata'` is deliberately NOT overwritten: it comes back if they
 * subscribe.
 */
export function toMediaQuality({
  imageFormat,
  canUseLossless,
}: {
  imageFormat?: string | null;
  canUseLossless?: boolean;
}): MediaQuality {
  return canUseLossless && imageFormat === 'metadata' ? 'lossless' : 'compressed';
}

/**
 * Whether these options resolve to the stored original rather than a derived variant.
 *
 * Mirrors the inference `getEdgeUrl` makes on its own arguments. Split out because
 * `resolveOptimized` has to reach the same answer BEFORE `getEdgeUrl` runs: the cacher ignores
 * `optimized` on an original request, but emitting it still changes the URL, and therefore the
 * CDN cache key, for every download.
 */
export function resolvesToOriginal({
  width,
  height,
  original,
}: Pick<EdgeUrlProps, 'width' | 'height' | 'original'>) {
  return original ?? (!width && !height);
}

/**
 * The `optimized` flag the render path emits.
 *
 * An explicit `optimized` from the call site wins, which is what keeps site chrome — stickers,
 * avatars, shop tiles, OG images, the announcement banner — compressed for everyone regardless
 * of who is looking. Otherwise the viewer's quality decides, at every width.
 */
export function resolveOptimized({
  optimized,
  width,
  height,
  original,
  quality,
}: Pick<EdgeUrlProps, 'optimized' | 'width' | 'height' | 'original'> & {
  quality?: MediaQuality;
}) {
  if (optimized) return true;
  if (resolvesToOriginal({ width, height, original })) return false;
  return quality !== 'lossless';
}

/**
 * Snap a requested width up to the next value in `COMMON_IMAGE_WIDTHS`.
 *
 * Behavior matches `ServeImageMiddleware.cs` in civitai-image-cacher:
 *  - If the width is already in the ladder, leave it alone.
 *  - Otherwise, return the first ladder value strictly greater than `width`.
 *  - If no ladder value is greater (i.e. the request exceeds the ladder top),
 *    return the original width unchanged so callers that explicitly oversized
 *    aren't capped here. `clampEdgeWidth` still applies.
 */
export function snapWidthToCommonSize(width: number): number {
  for (const size of COMMON_IMAGE_WIDTHS) {
    if (size === width) return width;
    if (size > width) return size;
  }
  return width;
}

/**
 * Snap a requested width DOWN to the nearest ladder value, never up.
 *
 * `snapWidthToCommonSize` rounds up, which is right for a layout box — you want at least as many
 * pixels as the box. It is wrong when the width is the SOURCE's own size, because the cacher
 * upscales: measured on an 832x1216 original, `width=1600` returns a real 1600x2338 JPEG of
 * 1,017,924 bytes, interpolated pixels carrying no detail the source did not have. Rounding down
 * to 800 asks for 153,776 bytes (optimized) at 4% less linear resolution than the source.
 */
export function snapWidthDownToCommonSize(width: number): number {
  let best: number = COMMON_IMAGE_WIDTHS[0];
  for (const size of COMMON_IMAGE_WIDTHS) {
    if (size === width) return width;
    if (size < width) best = size;
  }
  return Math.min(best, width);
}

/** Ceiling `getEdgeUrl` applies to a requested width, after the ladder snap. */
export const MAX_EDGE_WIDTH = 1800;

export function clampEdgeWidth(width: number) {
  return Math.min(width, MAX_EDGE_WIDTH);
}

/**
 * Device-pixel-ratio the hi-DPI `srcSet` targets.
 *
 * 3x is deliberately not offered: at the widths these surfaces request it clears the ladder
 * top and lands on `MAX_EDGE_WIDTH`, so a 3x candidate would buy 1800px over 1600px — 12%
 * more pixels for a whole extra variant to generate, cache and download.
 */
export const SRCSET_DPR = 2;

/**
 * `srcSet` pairing the 1x variant with one sized for a `SRCSET_DPR` display.
 *
 * x-descriptors rather than a `devicePixelRatio` read: the ratio is unknown during SSR, so
 * choosing a width from it would emit different markup on server and client — a hydration
 * mismatch, and a second download of whichever variant lost. The browser resolves a
 * descriptor list itself, before React runs.
 *
 * Returns undefined when the 2x variant would land on the same rung as the 1x one, so the
 * attribute is omitted rather than listing one URL twice.
 */
export function getEdgeUrlSrcSet(src: string, options: Omit<EdgeUrlProps, 'src'> = {}) {
  const { width, original, sourceWidth } = options;
  if (!src || src.startsWith('http') || src.startsWith('blob')) return undefined;
  if (!width || original) return undefined;

  const base = clampEdgeWidth(snapWidthToCommonSize(width));
  const scaled = hiDpiCandidateWidth(base, sourceWidth);
  if (!scaled) return undefined;

  // Floored, never rounded up: a descriptor that overstates a candidate's density tells the
  // browser it has pixels it does not have.
  const density = Math.floor((scaled / base) * 100) / 100;

  return [
    `${srcSetSafe(getEdgeUrl(src, { ...options, width: base }))} 1x`,
    `${srcSetSafe(getEdgeUrl(src, { ...options, width: scaled }))} ${density}x`,
  ].join(', ');
}

/**
 * The widest ladder rung that is larger than `base` without exceeding `SRCSET_DPR` times it.
 *
 * Deliberately NOT `snapWidthToCommonSize(base * SRCSET_DPR)`, which rounds the doubled width UP
 * to the next rung and so OVERSHOOTS whenever 2x lands between rungs. A 450px card doubles to 900,
 * and the rung above 900 is 1200 — measured on the live CDN, `width=900` is byte-identical to
 * `width=1200` (239,932 bytes, 1200x1754 actual pixels) because the cacher snaps server-side too.
 * That is 5x the bytes of the 450 variant for a box that renders ~318 CSS px, which is why card
 * feeds could not take a srcSet at all.
 *
 * Taking the rung BELOW the 2x target instead gives cards 800 (153,776 bytes) at a true 1.77x,
 * which still covers a DPR-2 card outright.
 *
 * 🔴 Also bounded by the SOURCE's width, because the cacher upscales rather than refusing. Measured
 * on an 832x1216 original, post detail's 2x candidate of 1600 comes back as a real 1600x2338 WebP
 * of 335,598 bytes against 153,776 at 800 — 2.2x the bytes for pixels that are interpolated, not
 * captured. Most generated images are well under 1600 wide, so without this bound the 2x candidate
 * on a detail page is an upscale for the majority of them. No candidate is better than a fake one:
 * when nothing fits, the attribute is omitted and the browser keeps the 1x variant.
 */
export function hiDpiCandidateWidth(base: number, sourceWidth?: number | null) {
  const ceiling = Math.min(base * SRCSET_DPR, sourceWidth || Infinity);
  for (let i = COMMON_IMAGE_WIDTHS.length - 1; i >= 0; i--) {
    const rung = clampEdgeWidth(COMMON_IMAGE_WIDTHS[i]);
    if (rung > base && rung <= ceiling) return rung;
  }
  return undefined;
}

/**
 * A delivery URL ends in the image's `name`, which routinely contains spaces
 * ("..._Unstable Bastard_312879214.png"). `src` tolerates that — the browser encodes it — but
 * in `srcset` whitespace TERMINATES the URL, so the rest of the filename is read as the
 * descriptor, found invalid, and the candidate is silently dropped. Every candidate drops and
 * the browser falls back to `src`, i.e. the 1x variant, with no error anywhere.
 *
 * Only ASCII whitespace needs escaping, and each character is encoded as itself: the srcset
 * parser ends a URL at whitespace alone, so the commas `getEdgeUrl` puts in the params segment
 * are already safe where they sit, and a non-breaking space is not a terminator — rewriting one
 * to %20 would request a different object than `src` does.
 */
function srcSetSafe(url: string) {
  return url.replace(
    /[\t\n\f\r ]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
}

export function getEdgeUrl(
  src: string,
  {
    name,
    type,
    anim,
    transcode,
    width,
    height,
    original,
    fit,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    skip,
  }: Omit<EdgeUrlProps, 'src'> = {}
) {
  if (!src || src.startsWith('http') || src.startsWith('blob')) return src;

  if (!width && !height && original === undefined) original = true;
  if (original) {
    width = undefined;
    height = undefined;
  }
  // if(width && height) // TODO
  // Snap width to the cacher's CommonSizes ladder *before* the 1800 cap so the cap
  // remains the final word for over-ladder values. Height is not snapped — the
  // cacher only snaps width.
  if (width) width = clampEdgeWidth(snapWidthToCommonSize(width));
  if (height && height > 1000) height = 1000;

  const modifiedParams = {
    anim: anim ? undefined : anim,
    transcode: transcode ? true : undefined,
    width: width ?? undefined,
    height: height ?? undefined,
    original,
    fit,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    skip,
  };
  const params = Object.entries(modifiedParams)
    .map(([key, value]) => (value !== undefined ? `${key}=${value}` : undefined))
    .filter(isDefined)
    .join(',');

  const extension = typeExtensions[type ?? MediaType.image];

  // application-error logs indicate that `src` is sometimes undefined
  name = (name ?? src ?? '').replaceAll('%', ''); // % symbol is escape character for url encoding
  if (name.includes('.')) name = name.split('.').slice(0, -1).join('.') + extension;
  else name = name + extension;

  return [env.NEXT_PUBLIC_IMAGE_LOCATION, src, params.toString(), name].filter(Boolean).join('/');
}

const videoTypeExtensions = ['.gif', '.mp4', '.webm'];

export function getInferredMediaType(
  src: string,
  options?: { name?: string | null; type?: MediaType | undefined }
) {
  return (
    options?.type ??
    (videoTypeExtensions.some((ext) => (options?.name || src)?.endsWith(ext)) ? 'video' : 'image')
  );
}
