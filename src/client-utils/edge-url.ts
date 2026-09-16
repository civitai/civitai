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
  /** The stored image's own width. Bounds the hi-DPI `srcSet` candidate; never emitted into the URL. */
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

/**
 * `resolveOptimized` has to reach this answer BEFORE `getEdgeUrl` infers it: the cacher ignores
 * `optimized` on an original request, but emitting it still changes the URL — and therefore the
 * CDN cache key — for every download.
 */
export function resolvesToOriginal({
  width,
  height,
  original,
}: Pick<EdgeUrlProps, 'width' | 'height' | 'original'>) {
  return original ?? (!width && !height);
}

/**
 * Every derived variant is compressed. The only request that is not is an original, where the
 * cacher ignores the flag anyway — emitting it there would just split the CDN key.
 */
export function resolveOptimized({
  width,
  height,
  original,
}: Pick<EdgeUrlProps, 'width' | 'height' | 'original'>) {
  return !resolvesToOriginal({ width, height, original });
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
 * Returns undefined when no ladder rung fits between the 1x variant and the lower of
 * `SRCSET_DPR * base` and the source's own width — so the attribute is omitted rather than
 * listing one URL twice or promising pixels the source has not got.
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
 * The widest ladder rung above `base` that exceeds neither `SRCSET_DPR * base` nor the source.
 *
 * NOT `snapWidthToCommonSize(base * SRCSET_DPR)`: that rounds UP when 2x lands between rungs, so a
 * 450 card asks for 1200 — which the cacher serves identically to `width=1200`, ~5x the bytes of
 * the 450 rung for a box rendering ~318 CSS px.
 *
 * 🔴 The source bound is separate and equally load-bearing: the cacher UPSCALES rather than
 * refusing, so an unbounded 2x candidate bills real bytes for interpolated pixels on any image
 * narrower than the candidate — which most generated images are. When no rung fits, the attribute
 * is omitted and the browser keeps the 1x variant.
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
