// Keep dependency-free: the SDK mock host is meant to copy these regexes and the threshold verbatim.

export const INLINE_MEDIA_DATA_URI_REGEX = /^\s*data:(image|video|audio)\//i;

/** Base64 alphabet with optional `=` padding. Line-wrapped (MIME) base64 does not match. */
export const INLINE_MEDIA_RAW_BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Above any id, hash or token a step input carries. Raw base64 shorter than this is not
 * refused; only the data-URI clause catches a tiny image.
 */
export const INLINE_MEDIA_RAW_BASE64_MIN_CHARS = 4096;

/**
 * Values searched before giving up (fail open). Every JSON value serialises to at least one
 * byte, so this covers any input inside the 256 KiB byte cap; a larger one is refused by it.
 */
export const INLINE_MEDIA_MAX_VISITS = 262_144;

export type InlineMediaPath = (string | number)[];

export function isInlineMediaString(value: string): boolean {
  if (INLINE_MEDIA_DATA_URI_REGEX.test(value)) return true;
  return (
    value.length >= INLINE_MEDIA_RAW_BASE64_MIN_CHARS && INLINE_MEDIA_RAW_BASE64_REGEX.test(value)
  );
}

type Frame = { value: unknown; key: string | number | null; parent: Frame | null };

function pathOf(frame: Frame): InlineMediaPath {
  const path: InlineMediaPath = [];
  for (let f: Frame | null = frame; f && f.key !== null; f = f.parent) path.push(f.key);
  return path.reverse();
}

/**
 * The JSON path of the first string in `value`, in document order, that carries inline
 * media, or `null`. Iterative, so nesting depth cannot overflow the stack.
 */
export function findInlineMediaPath(value: unknown): InlineMediaPath | null {
  const stack: Frame[] = [{ value, key: null, parent: null }];
  let visits = 1;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    const node = frame.value;
    if (typeof node === 'string') {
      if (isInlineMediaString(node)) return pathOf(frame);
      continue;
    }
    if (node === null || typeof node !== 'object') continue;
    const children: Frame[] = [];
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (++visits > INLINE_MEDIA_MAX_VISITS) return null;
        children.push({ value: node[i], key: i, parent: frame });
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++visits > INLINE_MEDIA_MAX_VISITS) return null;
        children.push({ value: (node as Record<string, unknown>)[key], key, parent: frame });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
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
    `${formatInlineMediaPath(path)} carries inline media (data URI/base64); ` +
    `pass a hosted url instead — for an image, upload it with ` +
    `useImageUpload({ purpose: 'generationSource' }) or pick it with useImagePicker ` +
    `and pass the returned url`
  );
}
