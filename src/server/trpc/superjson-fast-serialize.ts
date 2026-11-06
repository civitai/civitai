import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';

/**
 * A faster `superjson.serialize` for the payload shapes tRPC responses actually carry, with
 * output IDENTICAL to `superjson.serialize` (same `json`, same `meta`, same key order) on every
 * input — anything outside the fast path is handed to `superjson.serialize` itself.
 *
 * Why it is faster: superjson's walker allocates two arrays per visited value (the path and the
 * ancestor list), records every object's path in an identity map, and runs each leaf through its
 * whole transformation rule list. For a tree of plain objects, arrays, strings, numbers, booleans,
 * nulls, `undefined` and Dates — which is what an edge-cacheable query (always written as
 * superjson) returns — none of that changes the output, so this walk skips it.
 *
 * Exact equivalence is kept by BAILING to `superjson.serialize(object)` on every case where the
 * walker's output depends on the work skipped, or on rules not mirrored here:
 *  - any value other than: string, boolean, null, undefined, a finite non-`-0` number, a valid
 *    `Date`, a plain object (prototype `Object.prototype` or `null`), or a dense array with no
 *    extra enumerable properties. So NaN, ±Infinity, -0, bigint, symbol, Map, Set, RegExp, Error,
 *    URL, typed arrays, functions, class instances (e.g. a Prisma Decimal) and invalid Dates all
 *    go to superjson;
 *  - any object (including a Date) reached twice — a shared or circular reference, which
 *    superjson records as `referentialEqualities`;
 *  - an object key `__proto__`, `constructor` or `prototype` (superjson throws on these; the
 *    bail lets it throw its own error);
 *  - any class, symbol or custom transformer registered on the default superjson instance,
 *    since those rules can claim values this walk would otherwise treat as plain.
 * A bail costs the partial walk plus a full superjson walk, so it is only worth it while bails
 * are rare. Getters on the input run again on a bail (the walk reads values, as superjson does).
 */

class Bail {}
const BAIL = new Bail();

/** superjson's annotation tree for one value: a type list for a leaf, a path-keyed map inside. */
type Annotations = string[] | Record<string, unknown> | undefined;

type Walked = { value: unknown; annotations: Annotations };

// superjson `escapeKey` (pathstringifier).
function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

const UNDEFINED_ANNOTATION = 'undefined';
const DATE_ANNOTATION = 'Date';

function walk(object: unknown, seen: Set<object>): Walked {
  switch (typeof object) {
    case 'string':
    case 'boolean':
      return { value: object, annotations: undefined };
    case 'undefined':
      // superjson: transformValue(undefined) -> { value: null, type: 'undefined' }
      return { value: null, annotations: [UNDEFINED_ANNOTATION] };
    case 'number':
      // NaN is not a superjson "primitive" (it enters the identity map), ±Infinity and -0 carry
      // a 'number' annotation: leave all three to superjson.
      if (!Number.isFinite(object) || (object === 0 && 1 / object === -Infinity)) throw BAIL;
      return { value: object, annotations: undefined };
    case 'object':
      break;
    default:
      // bigint, symbol, function
      throw BAIL;
  }
  if (object === null) return { value: null, annotations: undefined };

  if (seen.has(object)) throw BAIL;
  seen.add(object);

  if (object instanceof Date) {
    if (Object.getPrototypeOf(object) !== Date.prototype || isNaN(object.valueOf())) throw BAIL;
    return { value: object.toISOString(), annotations: [DATE_ANNOTATION] };
  }

  let inner: Record<string, unknown> | undefined;
  let transformed: unknown[] | Record<string, unknown>;

  if (Array.isArray(object)) {
    const length = object.length;
    // superjson iterates `Object.entries`, which skips holes and includes extra enumerable
    // properties; only a dense array with neither is walked here. With every index present
    // (checked per index below), the key count equals the length exactly when there are no
    // extra properties.
    if (Object.getPrototypeOf(object) !== Array.prototype || Object.keys(object).length !== length)
      throw BAIL;
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      if (!(i in object)) throw BAIL;
      const child = walk(object[i], seen);
      out.push(child.value);
      if (child.annotations !== undefined) inner = mergeChild(inner, String(i), child.annotations);
    }
    transformed = out;
  } else {
    const proto = Object.getPrototypeOf(object);
    if (proto !== Object.prototype && proto !== null) throw BAIL;
    const source = object as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const keys = Object.keys(source);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw BAIL;
      const child = walk(source[key], seen);
      out[key] = child.value;
      if (child.annotations !== undefined) inner = mergeChild(inner, key, child.annotations);
    }
    transformed = out;
  }
  return { value: transformed, annotations: inner };
}

// superjson walker: a leaf's type list lands at `escapeKey(index)`, a nested map is re-keyed
// under `escapeKey(index) + '.'`, in child order (the order the walker inserts them).
function mergeChild(
  inner: Record<string, unknown> | undefined,
  index: string,
  annotations: string[] | Record<string, unknown>
): Record<string, unknown> {
  const target = inner ?? {};
  const escaped = escapeKey(index);
  if (Array.isArray(annotations)) {
    target[escaped] = annotations;
  } else {
    for (const key of Object.keys(annotations)) target[escaped + '.' + key] = annotations[key];
  }
  return target;
}

type RegistryInternals = {
  classRegistry?: { kv?: { valueToKey?: Map<unknown, unknown> } };
  symbolRegistry?: { kv?: { valueToKey?: Map<unknown, unknown> } };
  customTransformerRegistry?: { transfomers?: Record<string, unknown> };
};

/**
 * True when nothing is registered on the default instance. Reads superjson internals; if their
 * shape is not the expected one this returns false, which only disables the fast path.
 */
function defaultInstanceHasNoRegistrations(): boolean {
  const instance = (superjson as unknown as { defaultInstance?: RegistryInternals })
    .defaultInstance;
  const classes = instance?.classRegistry?.kv?.valueToKey;
  const symbols = instance?.symbolRegistry?.kv?.valueToKey;
  const custom = instance?.customTransformerRegistry?.transfomers;
  return (
    classes instanceof Map &&
    classes.size === 0 &&
    symbols instanceof Map &&
    symbols.size === 0 &&
    !!custom &&
    Object.keys(custom).length === 0
  );
}

/** How one `fastSuperjsonSerialize` call ended (see `onOutcome`). */
export type FastSuperjsonOutcome = 'fast' | 'bail' | 'registry_off';

/**
 * `onOutcome`, when given, is told how the call ended, before the result is returned: `fast`
 * (the walk produced it), `bail` (handed to `superjson.serialize` after a partial walk) or
 * `registry_off` (a superjson registration disabled the walk; nothing was walked).
 */
export function fastSuperjsonSerialize(
  object: unknown,
  onOutcome?: (outcome: FastSuperjsonOutcome) => void
): SuperJSONResult {
  if (!defaultInstanceHasNoRegistrations()) {
    onOutcome?.('registry_off');
    return superjson.serialize(object);
  }
  let walked: Walked;
  try {
    walked = walk(object, new Set());
  } catch (error) {
    if (error === BAIL) {
      onOutcome?.('bail');
      return superjson.serialize(object);
    }
    throw error;
  }
  onOutcome?.('fast');
  const result: SuperJSONResult = { json: walked.value as SuperJSONResult['json'] };
  if (walked.annotations !== undefined) {
    result.meta = { values: walked.annotations as NonNullable<SuperJSONResult['meta']>['values'] };
    result.meta.v = 1;
  }
  return result;
}
