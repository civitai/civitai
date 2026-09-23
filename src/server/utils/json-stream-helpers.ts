import type { Writable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Same signature as the second argument to `JSON.stringify`.
 *
 * 🔴 SCOPE LIMIT, and it is the only way this helper can diverge from `JSON.stringify`:
 * a replacer here is applied to *values*, never to the document root and never with a
 * meaningful `key`/`this`. `writeJsonObject` serialises each top-level entry with its own
 * `JSON.stringify(value, replacer)` call, so the replacer sees `('', value)` with `this` bound
 * to that call's synthetic holder rather than `('someKey', value)` with `this` bound to the
 * whole document. For a replacer that branches only on `typeof value` — which is what a
 * bigint-to-string replacer does — the output is byte-identical, and
 * `json-stream-helpers.test.ts` asserts that byte-identity directly. A replacer that reads
 * `key` or `this` is NOT supported and will produce different bytes.
 */
export type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown;

/**
 * One top-level property of the document.
 *
 * `{ value }` is serialised in one shot — use it for anything already in memory and known to
 * be small (a single row, a scalar). `{ items }` is serialised element-by-element from a
 * (possibly async) iterable and is the whole point of this module: it lets an array of
 * unbounded length be written without the array or its JSON ever existing all at once.
 */
export type JsonObjectEntry =
  | { readonly value: unknown }
  | { readonly items: AsyncIterable<unknown> | Iterable<unknown> };

/**
 * Serialises `{ [key]: value, … }` as a stream of string chunks, byte-for-byte as
 * `JSON.stringify(object, replacer)` would (see the replacer scope limit above).
 *
 * The rules being mirrored, each of which is exercised by a test:
 * - key order is entry order, i.e. object insertion order;
 * - a property whose value serialises to `undefined` (an `undefined`, a function, a symbol) is
 *   OMITTED entirely, and the comma bookkeeping has to account for that;
 * - an array ELEMENT that serialises to `undefined` becomes `null` rather than being dropped;
 * - an empty array is `[]`, not the omission above.
 */
export async function* serializeJsonObject(
  entries: Iterable<readonly [string, JsonObjectEntry]>,
  replacer?: JsonReplacer
): AsyncGenerator<string, void, undefined> {
  yield '{';
  let wroteEntry = false;
  for (const [key, entry] of entries) {
    if ('items' in entry) {
      yield `${wroteEntry ? ',' : ''}${JSON.stringify(key)}:[`;
      wroteEntry = true;
      let first = true;
      for await (const item of entry.items) {
        // `JSON.stringify` renders an unserialisable ARRAY element as `null` (unlike an
        // unserialisable object property, which it drops). Matching that is what keeps the
        // element count of the streamed array equal to the element count of the in-memory one.
        yield `${first ? '' : ','}${JSON.stringify(item, replacer) ?? 'null'}`;
        first = false;
      }
      yield ']';
    } else {
      const json = JSON.stringify(entry.value, replacer);
      // Not a shortcut: `JSON.stringify({ a: undefined })` is `'{}'`, so emitting `"a":` here
      // would produce a document that is not merely different but syntactically invalid.
      if (json === undefined) continue;
      yield `${wroteEntry ? ',' : ''}${JSON.stringify(key)}:${json}`;
      wroteEntry = true;
    }
  }
  yield '}';
}

/**
 * Writes a JSON object to `sink` without ever materialising the document as a single string.
 *
 * Two independent ceilings this removes, both of which apply to
 * `fs.writeFile(path, JSON.stringify(everything))`:
 *
 * 1. `JSON.stringify` returns ONE JavaScript string, and a JS string has a hard maximum length.
 *    On 64-bit V8 that is `2^29 - 24` = **536,870,888 characters** (readable at runtime as
 *    `require('buffer').constants.MAX_STRING_LENGTH`); one character more throws
 *    `RangeError: Invalid string length`. That is a permanent, non-retryable failure: the same
 *    input fails identically on every attempt, no matter how much memory the host has.
 * 2. Even below the cap, the source rows and the rendered string are resident at the same time,
 *    so peak memory is roughly twice the document size on top of the rows themselves.
 *
 * Streaming replaces both with a peak that is one element's JSON plus the sink's high-water
 * mark. `pipeline` supplies the backpressure — the generator is only pulled from as fast as the
 * sink drains — and destroys the sink on error rather than leaving a half-written file open.
 *
 * `pipeline` also settles the question the caller actually cares about — this file is read back
 * with `fs.createReadStream` and uploaded immediately. It ends the sink and does not resolve
 * until the sink has closed, not merely finished, for a Writable with `autoDestroy` (the default,
 * and what `fs.createWriteStream` is). Measured on node v24.19.0 (the pinned toolchain) and again
 * on a node 26 host, over 20 rounds of a 4 MB document: `'close'` had already fired and the file
 * was byte-complete every time `pipeline` resolved. "the file is complete the instant writeJsonObject resolves" pins that as an outcome.
 *
 * 🔴 Do NOT add a second `await` on the sink's `'close'` here. A previous revision did, under a
 * comment asserting that `pipeline` gave no such guarantee. That assertion was false — and the
 * extra await was not harmless belt-and-braces: for a sink constructed with `autoDestroy: false`,
 * which this signature accepts, `'close'` never fires at all and `writeJsonObject` hangs forever.
 * `archive-helpers.ts` does need its own `'close'` wait and that is not an inconsistency to
 * "unify": what it awaits is archiver's `finalize()`, which resolves when the zip module ends and
 * knows nothing about the sink.
 */
export async function writeJsonObject({
  sink,
  entries,
  replacer,
}: {
  sink: Writable;
  entries: Iterable<readonly [string, JsonObjectEntry]>;
  replacer?: JsonReplacer;
}): Promise<void> {
  await pipeline(serializeJsonObject(entries, replacer), sink);
}
