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
 * Values one body may hold before it is refused outright. Twice what fits in a plain-JSON
 * body inside the byte cap; a body past it is padding, often with properties that hold
 * `undefined` (which the byte cap counts as zero bytes), so the search fails closed.
 */
export const INLINE_MEDIA_MAX_VISITS = 262_144;

export type InlineMediaPath = (string | number)[];

/** Shared by every field of one body, so many fields cannot each spend a full budget. */
export type InlineMediaBudget = { visits: number };

/** Returned when the body holds more than `INLINE_MEDIA_MAX_VISITS` values. */
export const INLINE_MEDIA_TOO_MANY_VALUES = 'too-many-values';

export function isInlineMediaString(value: string): boolean {
  if (INLINE_MEDIA_DATA_URI_REGEX.test(value)) return true;
  return (
    value.length >= INLINE_MEDIA_RAW_BASE64_MIN_CHARS && INLINE_MEDIA_RAW_BASE64_REGEX.test(value)
  );
}

/** One value in a walk: where it sits (`key` in `parent`, `null` at the root) and what it is. */
export type JsonWalkFrame = {
  value: unknown;
  key: string | number | null;
  parent: JsonWalkFrame | null;
};

/** `'stop'` ends the walk at this value; `'skip'` leaves its children unvisited. */
export type JsonWalkVisitor = (frame: JsonWalkFrame) => 'stop' | 'skip' | void;

function pathOf(frame: JsonWalkFrame): InlineMediaPath {
  const path: InlineMediaPath = [];
  for (let f: JsonWalkFrame | null = frame; f && f.key !== null; f = f.parent) path.push(f.key);
  return path.reverse();
}

/**
 * Visits every value in `value` in document order: array items by index, then own
 * enumerable keys in `for…in` order. A value referenced twice is visited twice. Each value
 * costs one visit from `budget`, charged when its container is opened, so a container with
 * too many children ends the walk before any of them is visited.
 *
 * Returns the frame `visit` stopped at, `null` once every value is visited, or
 * `INLINE_MEDIA_TOO_MANY_VALUES` once `budget` is spent. Iterative, so nesting depth cannot
 * overflow the stack. The inline-media search and `jsonLengthWithin` both walk with it.
 */
export function walkJsonValues(
  value: unknown,
  budget: InlineMediaBudget,
  visit: JsonWalkVisitor
): JsonWalkFrame | null | typeof INLINE_MEDIA_TOO_MANY_VALUES {
  const stack: JsonWalkFrame[] = [{ value, key: null, parent: null }];
  if (++budget.visits > INLINE_MEDIA_MAX_VISITS) return INLINE_MEDIA_TOO_MANY_VALUES;
  while (stack.length > 0) {
    const frame = stack.pop() as JsonWalkFrame;
    const verdict = visit(frame);
    if (verdict === 'stop') return frame;
    const node = frame.value;
    if (verdict === 'skip' || node === null || typeof node !== 'object') continue;
    const children: JsonWalkFrame[] = [];
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (++budget.visits > INLINE_MEDIA_MAX_VISITS) return INLINE_MEDIA_TOO_MANY_VALUES;
        children.push({ value: node[i], key: i, parent: frame });
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++budget.visits > INLINE_MEDIA_MAX_VISITS) return INLINE_MEDIA_TOO_MANY_VALUES;
        children.push({ value: (node as Record<string, unknown>)[key], key, parent: frame });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}

/**
 * The JSON path of the first string in `value`, in document order, that carries inline
 * media; `null` if none; `INLINE_MEDIA_TOO_MANY_VALUES` once `budget` is spent.
 */
export function findInlineMediaPath(
  value: unknown,
  budget: InlineMediaBudget = { visits: 0 }
): InlineMediaPath | null | typeof INLINE_MEDIA_TOO_MANY_VALUES {
  const hit = walkJsonValues(value, budget, (frame) =>
    typeof frame.value === 'string' && isInlineMediaString(frame.value) ? 'stop' : undefined
  );
  if (hit === INLINE_MEDIA_TOO_MANY_VALUES) return hit;
  return hit ? pathOf(hit) : null;
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
