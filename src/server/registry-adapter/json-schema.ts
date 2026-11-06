import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import type { JsonSchema } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A JSON Schema 2020-12 validator. `format` is an annotation here, as 2020-12 makes it by
 * default; unknown keywords (such as `x-successor`) are ignored rather than refused.
 */
export function newValidator() {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
}

/** Largest request filter this source will compile, as JSON. */
export const FILTER_MAX_BYTES = 8 * 1024;

/**
 * Whether `filter` holds a `pattern` or `patternProperties` key ANYWHERE in its JSON — in every
 * object and array, whatever the key above it. ajv evaluates a pattern with the platform's
 * backtracking RegExp, so a request could hand it one that blocks the event loop, and a pattern
 * reaches ajv through more than the schema keywords one would list (`dependencies`, or a `$ref`
 * to any member of the document). Walking everything is the only complete check. It can refuse a
 * harmless filter (an `enum` value or a property that happens to be named `pattern`); an unapplied
 * filter only costs traffic, since the registry checks it anyway.
 */
export function usesRegex(filter: unknown): boolean {
  const stack: unknown[] = [filter];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (Object.hasOwn(record, 'pattern') || Object.hasOwn(record, 'patternProperties')) {
        return true;
      }
      stack.push(...Object.values(record));
    }
  }
  return false;
}

/**
 * A request's `filter` as a predicate over bodies; `undefined` when there is none, or when this
 * source will not evaluate it — a filter over {@link FILTER_MAX_BYTES} or one using a regular
 * expression. A source may send more than a filter admits: the registry checks every entity
 * against the filter itself, so an unapplied filter only costs traffic.
 */
export type BodyPredicate = (body: unknown) => boolean;

export function createFilterCompiler(maxCached = 100) {
  const cache = new Map<string, BodyPredicate>();
  return (filter: JsonSchema | undefined): BodyPredicate | undefined => {
    if (filter === undefined) return undefined;
    const text = JSON.stringify(filter);
    if (text.length > FILTER_MAX_BYTES || usesRegex(filter)) return undefined;
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
