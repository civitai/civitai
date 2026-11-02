// App Blocks document store: COLLECTION SCHEMAS. A collection may declare `schema` (the JSON
// Schema subset `parseManifestStorage` admits; semantics in `APP_STORAGE_SCHEMA_KEYWORDS`), and
// then every document body written to it — create and put, whoever calls the store — must match
// it. Counters and marks are not document bodies and are never checked here.
//
// The schema is compiled once into a tree of closures and cached, keyed by the app, the
// collection and the schema's own JSON text: the declarations are re-parsed from the manifest on
// every request, so the text is the identity that survives a re-parse, and a manifest that
// changes the schema changes the key (an old entry is never served for a new schema).
//
// Errors name the FIRST failing JSON pointer (RFC 6901, into `data`). "First" is deterministic:
// within one schema, `type`, then `const`, `enum`, the string, number and array keywords, then
// `required` in its declared order, then the object's own keys in ascending (UTF-16) order.
// A string's `maxLength` is checked before its `pattern`, so a pattern never runs against a
// string longer than `APP_STORAGE_SCHEMA_PATTERNED_MAX_LENGTH`.
import type { DocCollection, DocStoreContext } from '~/server/services/apps/doc-store.types';
import { DocStoreError } from '~/server/services/apps/doc-store.types';
import type {
  AppStorageCollectionSchema,
  AppStorageSchemaType,
} from '~/shared/constants/block-storage.constants';
import { APP_STORAGE_SCHEMA_PATTERN_FLAGS } from '~/shared/constants/block-storage.constants';

type Failure = { pointer: string; keyword: string; reason: string };
type Check = (value: unknown, pointer: string) => Failure | null;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function hasType(t: AppStorageSchemaType, v: unknown): boolean {
  switch (t) {
    case 'object':
      return isObject(v);
    case 'array':
      return Array.isArray(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'null':
      return v === null;
    default:
      return typeof v === t;
  }
}

/** Equality of two JSON values (own keys only, any key order). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

const escapePointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
/** Length in code points, as JSON Schema counts it (a UTF-16 surrogate pair is one). */
const codePoints = (s: string) => Array.from(s).length;
const byUtf16 = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function compile(schema: AppStorageCollectionSchema): Check {
  const checks: Check[] = [];
  const fail = (pointer: string, keyword: string, reason: string): Failure => ({
    pointer,
    keyword,
    reason,
  });

  if (schema.type !== undefined) {
    const types = (
      Array.isArray(schema.type) ? schema.type : [schema.type]
    ) as AppStorageSchemaType[];
    const expected = types.join(' or ');
    checks.push((v, p) =>
      types.some((t) => hasType(t, v))
        ? null
        : fail(p, 'type', `expected ${expected}, got ${typeName(v)}`)
    );
  }
  if (Object.hasOwn(schema, 'const')) {
    const value = schema.const;
    checks.push((v, p) =>
      jsonEqual(v, value) ? null : fail(p, 'const', 'must equal the value the schema fixes (const)')
    );
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum as unknown[];
    checks.push((v, p) =>
      values.some((x) => jsonEqual(v, x))
        ? null
        : fail(p, 'enum', "must be one of the schema's enum values")
    );
  }

  const { minLength, maxLength, pattern, minimum, maximum, minItems, maxItems } = schema as Record<
    string,
    unknown
  >;
  if (typeof minLength === 'number') {
    checks.push((v, p) =>
      typeof v === 'string' && codePoints(v) < minLength
        ? fail(p, 'minLength', `must be at least ${minLength} characters`)
        : null
    );
  }
  if (typeof maxLength === 'number') {
    checks.push((v, p) =>
      typeof v === 'string' && codePoints(v) > maxLength
        ? fail(p, 'maxLength', `must be at most ${maxLength} characters`)
        : null
    );
  }
  if (typeof pattern === 'string') {
    // No `g` or `y` flag, so `test` keeps no state between calls.
    const re = new RegExp(pattern, APP_STORAGE_SCHEMA_PATTERN_FLAGS);
    checks.push((v, p) =>
      typeof v === 'string' && !re.test(v)
        ? fail(p, 'pattern', `must match the pattern ${JSON.stringify(pattern)}`)
        : null
    );
  }
  if (typeof minimum === 'number') {
    checks.push((v, p) =>
      typeof v === 'number' && v < minimum
        ? fail(p, 'minimum', `must be at least ${minimum}`)
        : null
    );
  }
  if (typeof maximum === 'number') {
    checks.push((v, p) =>
      typeof v === 'number' && v > maximum ? fail(p, 'maximum', `must be at most ${maximum}`) : null
    );
  }
  if (typeof minItems === 'number') {
    checks.push((v, p) =>
      Array.isArray(v) && v.length < minItems
        ? fail(p, 'minItems', `must have at least ${minItems} items`)
        : null
    );
  }
  if (typeof maxItems === 'number') {
    checks.push((v, p) =>
      Array.isArray(v) && v.length > maxItems
        ? fail(p, 'maxItems', `must have at most ${maxItems} items`)
        : null
    );
  }
  if (isObject(schema.items)) {
    const item = compile(schema.items);
    checks.push((v, p) => {
      if (!Array.isArray(v)) return null;
      for (let i = 0; i < v.length; i++) {
        const f = item(v[i], `${p}/${i}`);
        if (f) return f;
      }
      return null;
    });
  }

  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  // A Map, not the declared object: a property named `constructor` must not resolve to
  // Object.prototype's.
  const properties = new Map<string, Check>(
    isObject(schema.properties)
      ? Object.entries(schema.properties).map(([k, s]) => [
          k,
          compile(s as AppStorageCollectionSchema),
        ])
      : []
  );
  const additional = schema.additionalProperties;
  const additionalCheck = isObject(additional) ? compile(additional) : null;
  if (required.length > 0 || properties.size > 0 || additional !== undefined) {
    checks.push((v, p) => {
      if (!isObject(v)) return null;
      for (const k of required) {
        if (!Object.hasOwn(v, k))
          return fail(`${p}/${escapePointer(k)}`, 'required', 'is required');
      }
      for (const k of Object.keys(v).sort(byUtf16)) {
        const at = `${p}/${escapePointer(k)}`;
        const declared = properties.get(k);
        let f: Failure | null = null;
        if (declared) f = declared(v[k], at);
        else if (additional === false) {
          f = fail(at, 'additionalProperties', 'is not a property the schema allows');
        } else if (additionalCheck) f = additionalCheck(v[k], at);
        if (f) return f;
      }
      return null;
    });
  }

  return (value, pointer) => {
    for (const check of checks) {
      const f = check(value, pointer);
      if (f) return f;
    }
    return null;
  };
}

/**
 * Compiled validators, least recently used first. Bounded: one entry per (app, collection,
 * schema text), and an evicted one is only recompiled.
 */
const COMPILED_MAX = 256;
const compiled = new Map<string, Check>();

function compiledFor(appId: string, collection: string, schema: AppStorageCollectionSchema): Check {
  const key = `${appId}\u0000${collection}\u0000${JSON.stringify(schema)}`;
  let check = compiled.get(key);
  if (check) {
    compiled.delete(key);
  } else {
    check = compile(schema);
    if (compiled.size >= COMPILED_MAX) compiled.delete(compiled.keys().next().value as string);
  }
  compiled.set(key, check);
  return check;
}

/** Longest pointer quoted in a message; `details.pointer` always carries the whole one. */
const MESSAGE_POINTER_MAX = 200;

/**
 * THE schema check for a document body. Returns normally when `collection` declares no schema
 * or `data` matches it; otherwise throws `schema_violation` (HTTP 400) naming the first failing
 * JSON pointer, with `details: { collection, pointer, keyword }`.
 *
 * `ctx` is the context of the app that DECLARES the collection, and `data` is the WHOLE
 * document body the write would store — never a patch.
 */
export function validateDocAgainstCollectionSchema(
  ctx: Pick<DocStoreContext, 'appId'>,
  collection: DocCollection,
  data: unknown
): void {
  const schema = collection.config.schema;
  if (!schema) return;
  const failure = compiledFor(ctx.appId, collection.name, schema)(data, '');
  if (!failure) return;
  const { pointer, keyword, reason } = failure;
  const shown =
    pointer.length > MESSAGE_POINTER_MAX ? `${pointer.slice(0, MESSAGE_POINTER_MAX)}…` : pointer;
  const where = pointer === '' ? '"" (the document root)' : JSON.stringify(shown);
  throw new DocStoreError(
    'schema_violation',
    `document does not match the schema of collection ${collection.name} at ${where}: ${reason}`,
    { collection: collection.name, pointer, keyword }
  );
}
