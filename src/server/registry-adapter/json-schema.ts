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

// Keywords whose value is one schema, an array of schemas, or a map of name → schema.
const ONE = [
  'items',
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'additionalItems',
];
const MANY = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const MAP = ['properties', '$defs', 'definitions', 'dependentSchemas'];

/**
 * Whether `schema` uses a regular expression anywhere a schema can appear. ajv evaluates
 * `pattern` with the platform's backtracking RegExp, so a request could hand it one that blocks
 * the event loop. Only schema positions are walked: a property NAMED `pattern` is not a keyword.
 */
export function usesRegex(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  const s = schema as Record<string, unknown>;
  if ('pattern' in s || 'patternProperties' in s) return true;
  for (const k of ONE) if (usesRegex(s[k])) return true;
  for (const k of MANY) if (Array.isArray(s[k]) && (s[k] as unknown[]).some(usesRegex)) return true;
  for (const k of MAP) {
    const m = s[k];
    if (m && typeof m === 'object' && Object.values(m).some(usesRegex)) return true;
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
