/**
 * A job with more inputs than this is a collage, not a derivation worth tracking.
 *
 * Exported because the submit path now unions two independently-capped sources —
 * URL-derived ids and verified tokens — and a union of two 8s is a 16 unless the
 * caller applies the same bound.
 *
 * 🔴 It now does double duty: it is also the DoS bound the router applies to the
 * caller-controlled `sourceProvenance` array, where each element past it costs an
 * AES-GCM attempt. Raising this for a collage feature raises that ceiling too —
 * give the router its own constant before you do.
 */
export const MAX_SOURCE_IMAGES = 8;

/** The ids already verified for a stored image, to carry across an edit of its meta. */
export function storedSourceImageIds(meta: unknown): number[] | null {
  const extra = (meta as { extra?: unknown } | null | undefined)?.extra;
  const value = (extra as { sourceImageIds?: unknown } | null | undefined)?.sourceImageIds;
  if (!Array.isArray(value)) return null;
  const ids = value.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  return ids.length ? ids.slice(0, MAX_SOURCE_IMAGES) : null;
}
