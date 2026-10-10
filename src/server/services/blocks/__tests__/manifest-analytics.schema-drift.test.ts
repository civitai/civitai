import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import {
  BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH,
  BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH,
  BLOCK_ANALYTICS_MAX_ENUM_VALUES,
  BLOCK_ANALYTICS_MAX_EVENTS,
  BLOCK_ANALYTICS_MAX_PROPERTIES,
  BLOCK_ANALYTICS_NAME_RE,
  BLOCK_ANALYTICS_PROPERTY_TYPES,
} from '~/shared/constants/block-analytics.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drift guard — manifest `analytics`.
 *
 * The canonical published schema `public/schemas/app-block/v1.json` is what the
 * `civitai` CLI and the SDK byte-mirror and what editors validate against; the
 * imperative validator (`parseManifestAnalytics`, reached through
 * `BlockManifestValidator.validate`) is what submit enforces. If they disagree, an
 * author is green locally and rejected at submit, or the reverse.
 *
 * Two axes:
 *   1. Structural — every bound in the schema equals the exported constant.
 *   2. Behavioural — a shared table of `analytics` values is evaluated by BOTH the
 *      schema and the validator, and their verdicts must match.
 *
 * The repo has no JSON Schema engine as a dependency, so (2) uses the small
 * evaluator below. 🔴 It THROWS on any keyword it does not implement, so a schema
 * edit that introduces one fails this test instead of being silently ignored —
 * an evaluator that skips a keyword would report agreement it never checked.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

type Schema = Record<string, unknown>;
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
  required: string[];
  properties: Record<string, Schema>;
};
const analyticsSchema = schema.properties.analytics as Schema;

const ANNOTATIONS = new Set(['description', '$comment']);
const IMPLEMENTED = new Set([
  'type',
  'const',
  'enum',
  'properties',
  'patternProperties',
  'additionalProperties',
  'required',
  'maxProperties',
  'pattern',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'items',
  'oneOf',
  'allOf',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Evaluate `value` against the subset of draft 2020-12 the analytics schema uses. */
function schemaAccepts(s: Schema, value: unknown): boolean {
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
  if (typeof s.pattern === 'string' && typeof value === 'string') {
    if (!new RegExp(s.pattern, 'u').test(value)) return false;
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (typeof s.minLength === 'number' && len < s.minLength) return false;
    if (typeof s.maxLength === 'number' && len > s.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    if (s.uniqueItems === true) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) return false;
    }
    if (s.items && !value.every((v) => schemaAccepts(s.items as Schema, v))) return false;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const props = (s.properties ?? {}) as Record<string, Schema>;
    const patterns = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>);
    if (typeof s.maxProperties === 'number' && keys.length > s.maxProperties) return false;
    // 🔴 `Object.hasOwn`, never `in`: `in` walks the prototype, so a `constructor`
    // key would resolve to `Object` and be checked against no schema at all.
    if (Array.isArray(s.required) && !s.required.every((k: string) => Object.hasOwn(obj, k)))
      return false;
    for (const k of keys) {
      // Draft 2020-12: every matching `patternProperties` entry applies, and
      // `additionalProperties` covers only keys matched by neither map.
      const matched = patterns.filter(([re]) => new RegExp(re, 'u').test(k));
      for (const [, sub] of matched) if (!schemaAccepts(sub, obj[k])) return false;
      if (Object.hasOwn(props, k)) {
        if (!schemaAccepts(props[k], obj[k])) return false;
      } else if (matched.length > 0) {
        continue;
      } else if (s.additionalProperties === false) {
        return false;
      } else if (typeof s.additionalProperties === 'object') {
        if (!schemaAccepts(s.additionalProperties as Schema, obj[k])) return false;
      }
    }
  }
  if (Array.isArray(s.allOf) && !(s.allOf as Schema[]).every((sub) => schemaAccepts(sub, value)))
    return false;
  if (Array.isArray(s.oneOf)) {
    const matches = (s.oneOf as Schema[]).filter((sub) => schemaAccepts(sub, value)).length;
    if (matches !== 1) return false;
  }
  return true;
}

const VALID_MANIFEST = {
  blockId: 'test-block',
  version: '1.0.0',
  name: 'Test Block',
  contentRating: 'g',
  renderMode: 'iframe',
  trustTier: 'unverified',
  scopes: ['models:read:self'],
  iframe: {
    src: 'https://blocks.civitai.com/test',
    minHeight: 200,
    maxHeight: null,
    resizable: true,
    sandbox: 'allow-scripts',
  },
};
const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://blocks.civitai.com'],
};
const validatorAccepts = (analytics: unknown) =>
  BlockManifestValidator.validate({ ...VALID_MANIFEST, analytics }, APP_CTX).valid;

const named = (count: number, value: unknown, prefix = 'n_') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, value]));
const values = (count: number) => Array.from({ length: count }, (_, i) => `v${i}`);
const withProp = (decl: unknown, name = 'p') => ({
  events: { tapped: { properties: { [name]: decl } } },
});

const CASES: Array<[string, unknown, boolean]> = [
  // accept
  ['empty analytics', {}, true],
  ['empty events', { events: {} }, true],
  [
    'design example',
    {
      events: {
        generate_clicked: {
          description: 'User pressed Generate',
          properties: {
            mode: { type: 'enum', values: ['txt2img', 'img2img'] },
            batch: { type: 'number' },
            advanced: { type: 'boolean' },
          },
        },
      },
    },
    true,
  ],
  ['event with no body', { events: { level_up: {} } }, true],
  ['50 events', { events: named(BLOCK_ANALYTICS_MAX_EVENTS, {}) }, true],
  ['10 properties', withPropsCount(BLOCK_ANALYTICS_MAX_PROPERTIES), true],
  ['64-char event name', { events: { ['a'.repeat(64)]: {} } }, true],
  [
    '64-char property name',
    { events: { tapped: { properties: { ['b'.repeat(64)]: { type: 'number' } } } } },
    true,
  ],
  [
    '50 enum values',
    withProp({ type: 'enum', values: values(BLOCK_ANALYTICS_MAX_ENUM_VALUES) }),
    true,
  ],
  ['64-char enum value', withProp({ type: 'enum', values: ['c'.repeat(64)] }), true],
  ['200-char description', { events: { tapped: { description: 'd'.repeat(200) } } }, true],
  ['empty description', { events: { tapped: { description: '' } } }, true],
  // Astral characters are 1 code point but 2 UTF-16 units. JSON Schema `maxLength`
  // counts code points, so these are where a `.length`-based check would disagree.
  ['64 astral-char enum value', withProp({ type: 'enum', values: ['😀'.repeat(64)] }), true],
  ['200 astral-char description', { events: { tapped: { description: '😀'.repeat(200) } } }, true],
  ['65 astral-char enum value', withProp({ type: 'enum', values: ['😀'.repeat(65)] }), false],
  ['201 astral-char description', { events: { tapped: { description: '😀'.repeat(201) } } }, false],
  // `constructor` is the one Object.prototype member the name pattern admits; an
  // evaluator that resolves keys through the prototype accepts anything under it.
  ['`constructor` property, valid', withProp({ type: 'number' }, 'constructor'), true],
  ['`constructor` event, valid', { events: { constructor: { description: 'ok' } } }, true],
  // reject — container shapes
  // `constructor` as an UNKNOWN key of a fixed-key object: the only place a
  // `properties` lookup sees it, since map keys go through `patternProperties`.
  ['`constructor` as an unknown event key', { events: { tapped: { constructor: 'x' } } }, false],
  ['`constructor` as an unknown analytics key', { events: {}, constructor: 1 }, false],
  ['`constructor` event, invalid declaration', { events: { constructor: { label: 'x' } } }, false],
  [
    '`constructor` property, invalid declaration',
    withProp({ type: 'string' }, 'constructor'),
    false,
  ],
  ['analytics null', null, false],
  ['analytics array', [], false],
  ['analytics string', 'events', false],
  ['unknown analytics key', { events: {}, retention: 30 }, false],
  ['events array', { events: [] }, false],
  ['event null', { events: { tapped: null } }, false],
  ['properties array', { events: { tapped: { properties: [] } } }, false],
  ['unknown event key', { events: { tapped: { label: 'x' } } }, false],
  // reject — names
  ['uppercase event name', { events: { Tapped: {} } }, false],
  ['leading digit', { events: { '9lives': {} } }, false],
  ['leading underscore', { events: { _x: {} } }, false],
  ['hyphen', { events: { 'a-b': {} } }, false],
  ['empty name', { events: { '': {} } }, false],
  ['65-char event name', { events: { ['a'.repeat(65)]: {} } }, false],
  [
    'bad property name',
    { events: { tapped: { properties: { 'Bad-Name': { type: 'number' } } } } },
    false,
  ],
  // reject — counts
  ['51 events', { events: named(BLOCK_ANALYTICS_MAX_EVENTS + 1, {}) }, false],
  ['11 properties', withPropsCount(BLOCK_ANALYTICS_MAX_PROPERTIES + 1), false],
  // reject — property declarations
  ['string type', withProp({ type: 'string' }), false],
  ['missing type', withProp({}), false],
  ['declaration is a string', withProp('number'), false],
  ['enum without values', withProp({ type: 'enum' }), false],
  ['enum with 0 values', withProp({ type: 'enum', values: [] }), false],
  [
    'enum with 51 values',
    withProp({ type: 'enum', values: values(BLOCK_ANALYTICS_MAX_ENUM_VALUES + 1) }),
    false,
  ],
  ['duplicate enum values', withProp({ type: 'enum', values: ['x', 'y', 'x'] }), false],
  ['65-char enum value', withProp({ type: 'enum', values: ['c'.repeat(65)] }), false],
  ['empty enum value', withProp({ type: 'enum', values: [''] }), false],
  ['numeric enum value', withProp({ type: 'enum', values: [3] }), false],
  ['values on a number', withProp({ type: 'number', values: ['1'] }), false],
  ['extra key on a boolean', withProp({ type: 'boolean', default: true }), false],
  ['201-char description', { events: { tapped: { description: 'd'.repeat(201) } } }, false],
  ['numeric description', { events: { tapped: { description: 5 } } }, false],
];

function withPropsCount(count: number) {
  return { events: { tapped: { properties: named(count, { type: 'boolean' }, 'p_') } } };
}

describe('app-block v1 schema ⇄ analytics validator drift guard', () => {
  it('declares analytics as an OPTIONAL closed object', () => {
    expect(schema.required).not.toContain('analytics');
    expect(analyticsSchema.type).toBe('object');
    expect(analyticsSchema.additionalProperties).toBe(false);
  });

  it('pins every bound to the exported constants', () => {
    // A name-keyed map is `patternProperties` keyed on the name regex, closed with
    // `additionalProperties: false` — NOT `propertyNames`, which the CLI's
    // validator reports at the document root with no path to the bad key.
    const nameKeyed = (map: Schema): Schema => {
      expect(map.additionalProperties).toBe(false);
      expect(map.propertyNames).toBeUndefined();
      const entries = Object.entries(map.patternProperties as Record<string, Schema>);
      expect(entries.map(([re]) => re)).toEqual([BLOCK_ANALYTICS_NAME_RE.source]);
      return entries[0][1];
    };

    const events = (analyticsSchema.properties as Record<string, Schema>).events;
    expect(events.maxProperties).toBe(BLOCK_ANALYTICS_MAX_EVENTS);
    const event = nameKeyed(events);
    const eventProps = event.properties as Record<string, Schema>;
    expect(event.additionalProperties).toBe(false);
    expect(eventProps.description.maxLength).toBe(BLOCK_ANALYTICS_DESCRIPTION_MAX_LENGTH);

    const properties = eventProps.properties;
    expect(properties.maxProperties).toBe(BLOCK_ANALYTICS_MAX_PROPERTIES);
    const property = nameKeyed(properties);

    // allOf[0] checks `type` against the full list FIRST, so a validator that stops
    // or sorts by first error reports a wrong type rather than a missing `values`.
    const [typeCheck, arms] = property.allOf as Schema[];
    const typeEnum = ((typeCheck.properties as Record<string, Schema>).type as Schema).enum;
    expect(typeEnum).toEqual([...BLOCK_ANALYTICS_PROPERTY_TYPES]);
    const armTypes = (arms.oneOf as Schema[]).map(
      (arm) => ((arm.properties as Record<string, Schema>).type as Schema).const
    );
    expect(armTypes).toEqual([...BLOCK_ANALYTICS_PROPERTY_TYPES]);

    const enumValues = ((arms.oneOf as Schema[])[0].properties as Record<string, Schema>).values;
    expect(enumValues.minItems).toBe(1);
    expect(enumValues.maxItems).toBe(BLOCK_ANALYTICS_MAX_ENUM_VALUES);
    expect(enumValues.uniqueItems).toBe(true);
    expect((enumValues.items as Schema).maxLength).toBe(BLOCK_ANALYTICS_ENUM_VALUE_MAX_LENGTH);
  });

  it('the base manifest is valid, so only `analytics` can decide a verdict', () => {
    expect(validatorAccepts(undefined)).toBe(true);
  });

  it('the evaluator refuses a keyword it does not implement', () => {
    expect(() => schemaAccepts({ minimum: 1 }, 2)).toThrow(/does not implement "minimum"/);
  });

  it.each(CASES)('%s → schema and validator agree (accept=%s)', (_label, analytics, expected) => {
    expect(schemaAccepts(analyticsSchema, analytics)).toBe(expected);
    expect(validatorAccepts(analytics)).toBe(expected);
  });
});
