import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import type { JsonSchema } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A JSON Schema 2020-12 validator. `format` is an annotation here, as 2020-12 makes it by
 * default; unknown keywords (such as `x-migrateFrom`) are ignored rather than refused.
 */
export function newValidator() {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
}

/** Largest request filter this source will compile, as JSON. */
export const FILTER_MAX_BYTES = 8 * 1024;

/** Deepest object/array nesting a filter may have, so compiling it never recurses deeply. */
export const FILTER_MAX_DEPTH = 32;

/**
 * Keys that make a filter's evaluation cost unbounded by its size, refused wherever they appear:
 *   - `pattern`, `patternProperties`: ajv evaluates a pattern with the platform's backtracking
 *     RegExp, so a request could hand it one that blocks the event loop;
 *   - `$ref`, `$dynamicRef`, `$recursiveRef`, `$defs`, `definitions`: a reference lets a small
 *     filter reuse a subschema, so definitions that each hold two references to the next form a
 *     DAG whose evaluation doubles at every level. Without them every subschema is evaluated
 *     once per value it applies to, so the work is bounded by the filter's size times the body's.
 */
const REFUSED_FILTER_KEYS = [
  'pattern',
  'patternProperties',
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$defs',
  'definitions',
] as const;

/**
 * Whether this source refuses to evaluate `filter`: a {@link REFUSED_FILTER_KEYS} key ANYWHERE in
 * its JSON — in every object and array, whatever the key above it — or nesting deeper than
 * {@link FILTER_MAX_DEPTH}. A refused construct reaches ajv through more than the schema keywords
 * one would list (`dependencies`, a member of the document, an `enum`'s neighbour), so walking
 * everything is the only complete check. It can refuse a harmless filter (an `enum` value or a
 * property that happens to be named `pattern`); an unapplied filter only costs traffic, since the
 * registry checks it anyway (spec rule 6).
 *
 * ajv validation is synchronous and runs per entity, per poll, on the one event loop that serves
 * every stream, so a costly filter would stall every consumer, not just its sender.
 */
export function refusesFilter(filter: unknown): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: filter, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (depth > FILTER_MAX_DEPTH) return true;
    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    if (!Array.isArray(node)) {
      const record = node as Record<string, unknown>;
      if (REFUSED_FILTER_KEYS.some((key) => Object.hasOwn(record, key))) return true;
    }
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

/**
 * A request's `filter` as a predicate over bodies; `undefined` when there is none, or when this
 * source will not evaluate it — a filter over {@link FILTER_MAX_BYTES}, or one
 * {@link refusesFilter} refuses. A source may send more than a filter admits: the registry checks
 * every entity against the filter itself, so an unapplied filter only costs traffic.
 *
 * Compiled filters are cached by their text, at most `maxCached` of them (the cache is emptied
 * when full), so many distinct filters cost compile time, never unbounded memory.
 */
export type BodyPredicate = (body: unknown) => boolean;

export function createFilterCompiler(maxCached = 100) {
  const cache = new Map<string, BodyPredicate>();
  return (filter: JsonSchema | undefined): BodyPredicate | undefined => {
    if (filter === undefined) return undefined;
    const text = JSON.stringify(filter);
    if (text.length > FILTER_MAX_BYTES || refusesFilter(filter)) return undefined;
    const hit = cache.get(text);
    if (hit) return hit;
    let validate: ValidateFunction;
    try {
      validate = newValidator().compile(filter);
    } catch {
      throw new ProtocolError('bad_request', 'filter is not a valid JSON Schema');
    }
    const predicate = (body: unknown) => validate(body) === true;
    if (cache.size >= maxCached) cache.clear();
    cache.set(text, predicate);
    return predicate;
  };
}
