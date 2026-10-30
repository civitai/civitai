/**
 * A minimal JSON Schema (draft 2020-12) evaluator for the manifest drift guards.
 *
 * The repo has no JSON Schema engine as a dependency, so the drift tests that compare the
 * canonical `public/schemas/app-block/v1.json` against an imperative parser evaluate the
 * schema with this. ONE copy, shared by every drift test that needs it: a fix to how a
 * keyword is read must reach every guard, or one of them passes for the wrong reason.
 *
 * 🔴 It THROWS on any keyword it does not implement, so a schema edit that introduces one
 * fails the guard instead of being silently ignored — an evaluator that skips a keyword
 * would report agreement it never checked. Extend it, with a table row that must REFUSE
 * because of the new keyword, rather than adding the keyword to `ANNOTATIONS`.
 */

export type Schema = Record<string, unknown> | boolean;

const ANNOTATIONS = new Set(['description', '$comment']);
const IMPLEMENTED = new Set([
  'type',
  'const',
  'enum',
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'minProperties',
  'maxProperties',
  'pattern',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'minimum',
  'maximum',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Evaluate `value` against the subset of draft 2020-12 the manifest schema uses. */
export function schemaAccepts(s: Schema, value: unknown): boolean {
  if (s === true) return true;
  if (s === false) return false;
  for (const key of Object.keys(s)) {
    if (!IMPLEMENTED.has(key) && !ANNOTATIONS.has(key)) {
      throw new Error(`schema evaluator does not implement "${key}" — extend it`);
    }
  }
  const t = typeOf(value);
  if (s.type !== undefined && !(s.type === t || (s.type === 'number' && t === 'integer')))
    return false;
  if (Object.hasOwn(s, 'const') && s.const !== value) return false;
  if (Array.isArray(s.enum) && !s.enum.includes(value)) return false;
  if (typeof value === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) return false;
    // JSON Schema counts code points, not UTF-16 units.
    const len = [...value].length;
    if (typeof s.minLength === 'number' && len < s.minLength) return false;
    if (typeof s.maxLength === 'number' && len > s.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return false;
    if (typeof s.maximum === 'number' && value > s.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    if (s.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) return false;
    }
    if (s.items !== undefined && !value.every((v) => schemaAccepts(s.items as Schema, v)))
      return false;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>);
    if (typeof s.minProperties === 'number' && keys.length < s.minProperties) return false;
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) return false;
    // 🔴 `Object.hasOwn`, never `in`: `in` walks the prototype, so a `constructor` key would
    // resolve to `Object` and be checked against no schema at all.
    if (Array.isArray(s.required) && !s.required.every((k: string) => Object.hasOwn(obj, k)))
      return false;
    for (const k of keys) {
      // Draft 2020-12: `properties` AND every matching `patternProperties` entry apply;
      // `additionalProperties` covers only keys matched by neither.
      const matched = patterns.filter(([re]) => new RegExp(re, 'u').test(k));
      for (const [, sub] of matched) if (!schemaAccepts(sub, obj[k])) return false;
      const inProps = Object.hasOwn(props, k);
      if (inProps && !schemaAccepts(props[k], obj[k])) return false;
      if (inProps || matched.length > 0) continue;
      if (s.additionalProperties === false) return false;
      if (typeof s.additionalProperties === 'object') {
        if (!schemaAccepts(s.additionalProperties as Schema, obj[k])) return false;
      }
    }
  }
  if (Array.isArray(s.allOf) && !(s.allOf as Schema[]).every((sub) => schemaAccepts(sub, value)))
    return false;
  if (Array.isArray(s.anyOf) && !(s.anyOf as Schema[]).some((sub) => schemaAccepts(sub, value)))
    return false;
  if (Array.isArray(s.oneOf)) {
    const matches = (s.oneOf as Schema[]).filter((sub) => schemaAccepts(sub, value)).length;
    if (matches !== 1) return false;
  }
  if (s.not !== undefined && schemaAccepts(s.not as Schema, value)) return false;
  if (s.if !== undefined) {
    const branch = schemaAccepts(s.if as Schema, value) ? s.then : s.else;
    if (branch !== undefined && !schemaAccepts(branch as Schema, value)) return false;
  }
  return true;
}
