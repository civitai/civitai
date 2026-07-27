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
 * Below (and at) this requested width the render path forces `optimized=true`.
 *
 * 🔴 Load-bearing and deliberately shared: `useEdgeUrl` decides the `optimized` flag
 * from this number, so anything that has to reproduce a URL the browser actually
 * requests (e.g. `~/components/Announcements/announcement-image`, whose health monitor
 * would otherwise probe a variant nobody loads and report a false failure) must read
 * this constant rather than hardcoding the threshold.
 */
export const OPTIMIZED_WIDTH_THRESHOLD = 450;

/** Whether the render path forces `optimized=true` for a given requested width. */
export function shouldForceOptimized(width?: number | null) {
  return !!width && width <= OPTIMIZED_WIDTH_THRESHOLD;
}

/**
 * Snap a requested width up to the next value in `COMMON_IMAGE_WIDTHS`.
 *
 * Behavior matches `ServeImageMiddleware.cs` in civitai-image-cacher:
 *  - If the width is already in the ladder, leave it alone.
 *  - Otherwise, return the first ladder value strictly greater than `width`.
 *  - If no ladder value is greater (i.e. the request exceeds the ladder top),
 *    return the original width unchanged so callers that explicitly oversized
 *    aren't capped here. The existing 1800 cap in `getEdgeUrl` still applies.
 */
export function snapWidthToCommonSize(width: number): number {
  for (const size of COMMON_IMAGE_WIDTHS) {
    if (size === width) return width;
    if (size > width) return size;
  }
  return width;
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
  if (width) width = snapWidthToCommonSize(width);
  if (width && width > 1800) width = 1800;
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
