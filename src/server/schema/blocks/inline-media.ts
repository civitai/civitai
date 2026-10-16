// Dependency-free on purpose: the SDK mock host mirrors this file, so its regexes and
// threshold must stay copyable verbatim.

/** A string that is an inline image / video / audio data URI. */
export const INLINE_MEDIA_DATA_URI_REGEX = /^\s*data:(image|video|audio)\//i;

/** A string made only of the base64 alphabet, with optional `=` padding and no whitespace. */
export const INLINE_MEDIA_RAW_BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Shortest string the raw-base64 clause refuses. Far longer than any id, hash or token a
 * step input legitimately carries, and far shorter than any real encoded image.
 */
export const INLINE_MEDIA_RAW_BASE64_MIN_CHARS = 4096;

/** Containers deeper than this are not searched. */
export const INLINE_MEDIA_MAX_DEPTH = 64;

/** Values visited before the search gives up. */
export const INLINE_MEDIA_MAX_VISITS = 100_000;

export type InlineMediaPath = (string | number)[];

export function isInlineMediaString(value: string): boolean {
  if (INLINE_MEDIA_DATA_URI_REGEX.test(value)) return true;
  return (
    value.length >= INLINE_MEDIA_RAW_BASE64_MIN_CHARS && INLINE_MEDIA_RAW_BASE64_REGEX.test(value)
  );
}

/**
 * The JSON path of the first string in `value` that carries inline media, or `null`.
 *
 * Fails open past the depth and visit caps: this is a guidance check, and the byte cap
 * still bounds the payload.
 */
export function findInlineMediaPath(value: unknown): InlineMediaPath | null {
  let visits = 0;
  const walk = (node: unknown, path: InlineMediaPath, depth: number): InlineMediaPath | null => {
    if (++visits > INLINE_MEDIA_MAX_VISITS) return null;
    if (typeof node === 'string') return isInlineMediaString(node) ? path : null;
    if (node === null || typeof node !== 'object' || depth >= INLINE_MEDIA_MAX_DEPTH) return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const hit = walk(node[i], [...path, i], depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    for (const [key, child] of Object.entries(node)) {
      const hit = walk(child, [...path, key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(value, [], 0);
}

/** `['input', 'images', 0]` → `input.images[0]`. */
export function formatInlineMediaPath(path: InlineMediaPath): string {
  return path.reduce<string>((out, seg) => {
    if (typeof seg === 'number') return `${out}[${seg}]`;
    return out ? `${out}.${seg}` : seg;
  }, '');
}

export function inlineMediaMessage(path: InlineMediaPath): string {
  return (
    `step input field ${formatInlineMediaPath(path)} carries inline media (data URI/base64); ` +
    `pass a hosted url instead — for an image, upload it with ` +
    `useImageUpload({ purpose: 'generationSource' }) or pick it with useImagePicker ` +
    `and pass the returned url`
  );
}
