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

/**
 * Shared by every field of one body, so many fields cannot each spend a full budget.
 * `stringChars` is a lower bound on the body's JSON length, counted from the strings the
 * search has passed; `inspected` counts the characters handed to the patterns. `maxVisits`
 * replaces `INLINE_MEDIA_MAX_VISITS` as the value budget, for a caller whose own cap needs a
 * smaller or larger one.
 */
export type InlineMediaBudget = {
  visits: number;
  stringChars?: number;
  inspected?: number;
  maxVisits?: number;
};

/** Returned when the body holds more values than the budget allows (`INLINE_MEDIA_MAX_VISITS`). */
export const INLINE_MEDIA_TOO_MANY_VALUES = 'too-many-values';

/**
 * Returned once the strings already passed make the body's JSON longer than the byte limit
 * the caller named. From there no further string is read (the walk still finishes, for the
 * value budget), so the patterns never read more than the limit plus the string that crosses
 * it; the caller's byte cap refuses the body.
 */
export const INLINE_MEDIA_OVER_BYTE_LIMIT = 'over-byte-limit';

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
  const maxVisits = budget.maxVisits ?? INLINE_MEDIA_MAX_VISITS;
  const stack: JsonWalkFrame[] = [{ value, key: null, parent: null }];
  if (++budget.visits > maxVisits) return INLINE_MEDIA_TOO_MANY_VALUES;
  while (stack.length > 0) {
    const frame = stack.pop() as JsonWalkFrame;
    const verdict = visit(frame);
    if (verdict === 'stop') return frame;
    const node = frame.value;
    if (verdict === 'skip' || node === null || typeof node !== 'object') continue;
    const children: JsonWalkFrame[] = [];
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (++budget.visits > maxVisits) return INLINE_MEDIA_TOO_MANY_VALUES;
        children.push({ value: node[i], key: i, parent: frame });
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++budget.visits > maxVisits) return INLINE_MEDIA_TOO_MANY_VALUES;
        children.push({ value: (node as Record<string, unknown>)[key], key, parent: frame });
      }
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return null;
}

/**
 * A container whose own entries `JSON.stringify` writes as they are: an array or a plain
 * object, without `toJSON` (own or inherited) and not a boxed value.
 */
function writesOwnEntries(value: object): boolean {
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') return false;
  if (value instanceof String || value instanceof Number || value instanceof Boolean) return false;
  return true;
}

/**
 * The JSON path of the first string in `value`, in document order, that carries inline
 * media; `null` if none; `INLINE_MEDIA_TOO_MANY_VALUES` once `budget` is spent.
 *
 * With a `byteLimit`, each string is checked BEFORE its length is counted, so the string
 * that crosses the limit is still searched: an over-limit photo gets this message, not the
 * byte cap's. Once the counted strings pass the limit, no later string is read; the walk
 * still finishes, so a body past the value budget is reported as before, and otherwise the
 * search returns `INLINE_MEDIA_OVER_BYTE_LIMIT`. The count is a lower bound on the JSON
 * length (each string's characters and quotes, only where `JSON.stringify` writes it), so it
 * never passes the limit for a body that fits.
 */
export function findInlineMediaPath(
  value: unknown,
  budget: InlineMediaBudget = { visits: 0 },
  byteLimit = Infinity
):
  | InlineMediaPath
  | null
  | typeof INLINE_MEDIA_TOO_MANY_VALUES
  | typeof INLINE_MEDIA_OVER_BYTE_LIMIT {
  // Containers whose entries `JSON.stringify` does not write as they are (a boxed value, an
  // object with `toJSON`), and everything under them: their strings are not counted.
  const unwritten = new Set<JsonWalkFrame>();
  let overLimit = false;
  const hit = walkJsonValues(value, budget, (frame) => {
    const node = frame.value;
    const counted = !(frame.parent && unwritten.has(frame.parent));
    if (node !== null && typeof node === 'object') {
      if (!counted || !writesOwnEntries(node)) unwritten.add(frame);
      return undefined;
    }
    if (typeof node !== 'string') return undefined;
    if ((budget.stringChars ?? 0) > byteLimit) {
      overLimit = true;
      return undefined;
    }
    budget.inspected = (budget.inspected ?? 0) + node.length;
    if (isInlineMediaString(node)) return 'stop';
    if (counted) budget.stringChars = (budget.stringChars ?? 0) + node.length + 2;
    return undefined;
  });
  if (hit === INLINE_MEDIA_TOO_MANY_VALUES) return hit;
  if (overLimit) return INLINE_MEDIA_OVER_BYTE_LIMIT;
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
    `pass a hosted url instead — upload the image, video or audio with useMediaUpload ` +
    `(an image also works with useImageUpload({ purpose: 'generationSource' }) or ` +
    `useImagePicker) and pass the returned url`
  );
}
