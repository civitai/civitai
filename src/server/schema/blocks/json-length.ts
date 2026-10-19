import { walkJsonValues } from '~/server/schema/blocks/inline-media';
import type { InlineMediaBudget, JsonWalkFrame } from '~/server/schema/blocks/inline-media';

/**
 * `'utf16'` is `JSON.stringify(v).length`; `'utf8'` is
 * `Buffer.byteLength(JSON.stringify(v), 'utf8')`.
 */
export type JsonLengthUnit = 'utf16' | 'utf8';

/**
 * Running state of one `jsonLengthWithin` check. `visits` counts values against the walk's value
 * budget: `maxVisits` when set, otherwise the inline-media one (`measureJsonLength` sets half its
 * limit), so a bare `jsonLengthWithin` gives up where the inline-media search does. `chars` is
 * the length counted so far, in the chosen unit. `scanned` counts the string code units read
 * to find escapes: the measure's work, which tests read. `nulOrLoneSurrogate` is set once a string
 * the measure read holds a NUL or an unpaired surrogate, the characters `JSON.stringify` writes as
 * a `\u0000` or `\udXXX` escape. A measure that returns `false` leaves later strings unread, so the
 * flag only covers the whole value when the measure returns `true`.
 */
export type JsonLengthMeter = InlineMediaBudget & {
  chars: number;
  scanned: number;
  nulOrLoneSurrogate?: boolean;
};

/** The length `JSON.stringify(s)` has in `unit`. */
function quotedLength(s: string, unit: JsonLengthUnit, meter: JsonLengthMeter): number {
  meter.scanned += s.length;
  const utf8 = unit === 'utf8';
  let length = s.length + 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c === 0x22 || c === 0x5c) length += 1;
      else if (c < 0x20) {
        // \b \t \n \f \r get a two-character escape; every other control character is \u00XX.
        length += c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d ? 1 : 5;
        if (c === 0) meter.nulOrLoneSurrogate = true;
      }
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        i++;
        if (utf8) length += 2; // two code units, four UTF-8 bytes
      } else {
        length += 5; // a lone surrogate is written as the ASCII escape \uXXXX
        meter.nulOrLoneSurrogate = true;
      }
    } else if (utf8) {
      length += c < 0x800 ? 1 : 2;
    }
  }
  return length;
}

/** `quotedLength`, or a lower bound already past `room` without reading the string. */
function boundedQuotedLength(
  s: string,
  room: number,
  unit: JsonLengthUnit,
  meter: JsonLengthMeter
): number {
  // Escapes and multi-byte characters only lengthen a string, so one that cannot fit as
  // bare code units is already over.
  return s.length + 2 > room ? s.length + 2 : quotedLength(s, unit, meter);
}

/**
 * What `JSON.stringify` writes in place of `value`: `toJSON(key)` applied, then a boxed
 * number, string or boolean unwrapped.
 */
function serialisedValue(value: unknown, key: string): unknown {
  let resolved = value;
  if ((value !== null && typeof value === 'object') || typeof value === 'bigint') {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') resolved = toJSON.call(value, key);
  }
  if (resolved instanceof Number) return Number(resolved);
  if (resolved instanceof String) return String(resolved);
  if (resolved instanceof Boolean) return resolved.valueOf();
  if (resolved instanceof BigInt) return resolved.valueOf();
  return resolved;
}

/**
 * Adds the JSON length of `value` to `meter.chars`, counting 0 for a top-level value
 * `JSON.stringify` returns `undefined` for. Returns `false` as soon as the total passes
 * `limit` or the value budget runs out, leaving the rest unread. Throws the `TypeError`
 * `JSON.stringify` throws for a bigint or a cycle it reaches first. `resolved` marks a
 * top-level value that is already a `toJSON` result, which `JSON.stringify` does not
 * resolve again.
 */
function addJsonLength(
  value: unknown,
  limit: number,
  unit: JsonLengthUnit,
  meter: JsonLengthMeter,
  resolved = false
): boolean {
  // Containers that have written an entry, so the next one is preceded by a comma.
  const written = new Set<JsonWalkFrame>();
  // The containers enclosing the current value, to recognise a cycle.
  const open: JsonWalkFrame[] = [];
  const onPath = new Set<unknown>();
  const stopped = walkJsonValues(value, meter, (frame) => {
    const { key, parent } = frame;
    while (open.length > 0 && open[open.length - 1] !== parent) {
      onPath.delete((open.pop() as JsonWalkFrame).value);
    }
    const node =
      resolved && parent === null
        ? frame.value
        : serialisedValue(frame.value, key === null ? '' : String(key));
    const omitted = node === undefined || typeof node === 'function' || typeof node === 'symbol';
    // An object leaves such a property out and the top level writes nothing; an array
    // writes `null` in its place.
    if (omitted && typeof key !== 'number') return 'skip';

    let length = 0;
    if (parent) {
      if (written.has(parent)) length += 1;
      else written.add(parent);
      if (typeof key === 'string') {
        length += boundedQuotedLength(key, limit - meter.chars - length, unit, meter) + 1;
      }
    }
    // A value `toJSON` or unboxing replaced is measured as its replacement, never walked.
    const verdict = node === frame.value ? undefined : 'skip';
    if (omitted || node === null) length += 4;
    else if (typeof node === 'boolean') length += node ? 4 : 5;
    else if (typeof node === 'number') length += Number.isFinite(node) ? String(node).length : 4;
    else if (typeof node === 'string') {
      length += boundedQuotedLength(node, limit - meter.chars - length, unit, meter);
    } else if (typeof node === 'bigint') {
      throw new TypeError('Do not know how to serialize a BigInt');
    } else if (node === frame.value) {
      if (onPath.has(node)) throw new TypeError('Converting circular structure to JSON');
      open.push(frame);
      onPath.add(node);
      length += 2; // brackets; each entry adds its own comma
    } else {
      // `toJSON` returned a different object: it is measured in place of this one.
      meter.chars += length;
      length = 0;
      if (meter.chars > limit || !addJsonLength(node, limit, unit, meter, true)) return 'stop';
    }
    meter.chars += length;
    return meter.chars > limit ? 'stop' : verdict;
  });
  return stopped === null;
}

/**
 * Whether the summed JSON length of `values` is at most `limit`: the verdict
 * `JSON.stringify` would give, without building the strings. A deserialised input can hold
 * one object or string many times over; every occurrence counts, as it does in the string,
 * and the measure stops once the total passes `limit` instead of serialising the rest. Its
 * work is bounded by `limit` code units plus the value budget (`meter.maxVisits`, by default
 * `INLINE_MEDIA_MAX_VISITS`); a value past that budget is refused, as the inline-media search
 * refuses it.
 */
// A `const`, not a `function`, so the block-token schema scan (no-unguarded-block-bridge-token)
// can read it from the schemas that call it.
export const jsonLengthWithin = (
  values: unknown[],
  limit: number,
  {
    unit = 'utf16',
    meter = { visits: 0, chars: 0, scanned: 0 },
  }: { unit?: JsonLengthUnit; meter?: JsonLengthMeter } = {}
): boolean => {
  for (const value of values) {
    if (!addJsonLength(value, limit, unit, meter)) return false;
  }
  return true;
};

/**
 * `jsonLengthWithin` as a verdict, for a caller that serializes the value itself once it is known
 * to be within `limit`: `'within'`, `'over'` (the length passed `limit`, or the value budget ran
 * out), or `'unserializable'` where the measure throws because `JSON.stringify` would (a bigint, a
 * cycle, a throwing `toJSON` or getter) before reaching `limit`. A caller that wants
 * JSON.stringify's own error for that value can treat `'unserializable'` like `'within'` and let
 * its stringify throw.
 *
 * The value budget defaults to half of `limit`: every value JSON.stringify writes costs at least
 * two units (a one-character value and its separator), in either unit, so a value within `limit`
 * that writes out every entry needs no more. One with more (only possible with entries
 * JSON.stringify leaves out, such as `undefined` properties) is `'over'`. A caller can set
 * `meter.maxVisits` to choose another budget.
 */
export const measureJsonLength = (
  values: unknown[],
  limit: number,
  {
    unit,
    meter = { visits: 0, chars: 0, scanned: 0 },
  }: { unit?: JsonLengthUnit; meter?: JsonLengthMeter } = {}
): 'within' | 'over' | 'unserializable' => {
  meter.maxVisits ??= Math.floor(limit / 2);
  try {
    return jsonLengthWithin(values, limit, { unit, meter }) ? 'within' : 'over';
  } catch {
    return 'unserializable';
  }
};
