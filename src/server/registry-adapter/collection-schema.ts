/**
 * Collection schemas as registry schema entities: one JSON Schema 2020-12 document per
 * (app, collection, major), and the majors themselves, recomputed from the approved manifest
 * history on every read so the adapter keeps no state for them.
 *
 * The rule for a major is the registry's (`@vN` changes only additively: annotations and new
 * optional properties). It is wider than the store's own "breaking" (narrowings only), so it
 * mints on every store-breaking change and on widenings the store accepts in place.
 */
import { jsonEqual } from '~/server/services/apps/doc-store-schema';
import type {
  AppStorageCollectionSchema,
  DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';
import { registryUrn } from '~/server/registry-adapter/urn';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Annotation on an old major naming the URN of the major that replaced it.
 * @ai: the keyword name is pending the registry's owners (whether it belongs in the spec).
 */
export const SUCCESSOR_ANNOTATION = 'x-successor';

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

// JSON Schema 2020-12 meta-data vocabulary, plus `$comment` and `x-` extension keys.
const ANNOTATION_KEYWORDS = new Set([
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  '$comment',
]);
const isAnnotation = (k: string) => ANNOTATION_KEYWORDS.has(k) || k.startsWith('x-');

function withoutAnnotations(node: Node): Node {
  return Object.fromEntries(Object.entries(node).filter(([k]) => !isAnnotation(k)));
}

function sameSet(a: unknown, b: unknown): boolean {
  const xs = Array.isArray(a) ? a : a === undefined ? [] : [a];
  const ys = Array.isArray(b) ? b : b === undefined ? [] : [b];
  return (
    xs.length === ys.length &&
    xs.every((x) => ys.some((y) => jsonEqual(x, y))) &&
    ys.every((y) => xs.some((x) => jsonEqual(x, y)))
  );
}

const STRUCTURAL = new Set(['properties', 'required', 'items', 'additionalProperties']);
const UNORDERED = new Set(['type', 'enum']);

function subschemaAdditive(before: unknown, after: unknown): boolean {
  if (before === undefined || after === undefined) return before === after;
  return nodeAdditive(before, after);
}

function nodeAdditive(beforeRaw: unknown, afterRaw: unknown): boolean {
  if (!isObj(beforeRaw) || !isObj(afterRaw)) return jsonEqual(beforeRaw, afterRaw);
  const before = withoutAnnotations(beforeRaw);
  const after = withoutAnnotations(afterRaw);

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (STRUCTURAL.has(key)) continue;
    const same = UNORDERED.has(key)
      ? sameSet(before[key], after[key]) && Object.hasOwn(before, key) === Object.hasOwn(after, key)
      : jsonEqual(before[key], after[key]);
    if (!same) return false;
  }
  if (!sameSet(before.required, after.required)) return false;
  if (!subschemaAdditive(before.items, after.items)) return false;
  if (!subschemaAdditive(before.additionalProperties, after.additionalProperties)) return false;

  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};
  if (!isObj(beforeProps) || !isObj(afterProps)) return jsonEqual(beforeProps, afterProps);
  for (const key of Object.keys(beforeProps)) {
    if (!Object.hasOwn(afterProps, key)) return false;
    if (!nodeAdditive(beforeProps[key], afterProps[key])) return false;
  }
  const beforeRequired = Array.isArray(before.required) ? before.required : [];
  for (const key of Object.keys(afterProps)) {
    if (Object.hasOwn(beforeProps, key)) continue;
    // A new property is additive only where the old schema said nothing about that key: not
    // when it was already required, and not when an `additionalProperties` schema held it.
    if (beforeRequired.includes(key)) return false;
    if (isObj(before.additionalProperties)) return false;
  }
  return true;
}

/**
 * Whether `after` keeps the promise of `before`'s major: it differs only by annotations and new
 * optional properties (registry design, "Versions"). `undefined` is a collection with no
 * schema, which accepts anything; giving it any constraint is not additive.
 */
export function isAdditive(
  before: AppStorageCollectionSchema | undefined,
  after: AppStorageCollectionSchema | undefined
): boolean {
  const annotationOnly = (s: AppStorageCollectionSchema) =>
    Object.keys(withoutAnnotations(s as Node)).length === 0;
  if (before === undefined) return after === undefined || annotationOnly(after);
  if (after === undefined) return annotationOnly(before);
  return nodeAdditive(before, after);
}

/** The registry schema document for one major of a collection. */
export function synthesizeCollectionSchema(args: {
  urn: string;
  declared: AppStorageCollectionSchema | undefined;
  successorUrn?: string;
}): Record<string, unknown> {
  return {
    ...(args.declared ?? {}),
    $schema: JSON_SCHEMA_DIALECT,
    $id: args.urn,
    ...(args.successorUrn ? { [SUCCESSOR_ANNOTATION]: args.successorUrn } : {}),
  };
}

export type ManifestStep = {
  /** The publish request id, or {@link HEAD_STEP} for `app_blocks.manifest`. */
  id: string;
  manifest: unknown;
};

/** The step id of the enforced manifest, appended after the approved history. */
export const HEAD_STEP = 'head';

export type CollectionMajors = {
  /** Whether the newest parseable manifest declares the collection. */
  declared: boolean;
  /** The newest declaration within each major, index 0 = `@v1`. `undefined` = no schema. */
  majors: Array<AppStorageCollectionSchema | undefined>;
};

export type MajorDerivation = {
  collections: Map<string, CollectionMajors>;
  /** Step id → collection → the major that step's manifest declared it under. */
  stepMajors: Map<string, Map<string, number>>;
};

/**
 * Recompute every collection's majors from `steps`: the approved publish requests in review
 * order, then the enforced manifest. A transition mints the next major exactly when it is not
 * {@link isAdditive}. That covers the store's own breaking changes, an acknowledge-only one
 * included: the store's breaking list (`checkStorageMigrations`) is a subset of the
 * non-additive changes, which the "store-breaking ⇒ not additive" table in
 * `__tests__/collection-schema.test.ts` pins. A collection removed and declared again is compared
 * with its last declaration. A manifest whose storage does not parse is skipped, as the store
 * skips it.
 */
export function deriveCollectionMajors(steps: readonly ManifestStep[]): MajorDerivation {
  const collections = new Map<string, CollectionMajors & { last: DeclaredStorageCollection }>();
  const stepMajors = new Map<string, Map<string, number>>();

  for (const step of steps) {
    // Every feature on: this replays APPROVED manifests for their shape, and a step must parse
    // whether or not a feature it used is switched on today. Whether a feature may ACT (such as
    // publishing a collection) is decided by the live switch where it acts (`doc-streams.ts`).
    const parsed = parseManifestStorage(step.manifest, APP_STORAGE_ALL_FEATURES_ON);
    const declaredHere = new Map<string, number>();
    stepMajors.set(step.id, declaredHere);
    if (parsed.errors.length > 0) continue;

    for (const state of collections.values()) state.declared = false;
    for (const [name, now] of parsed.collections) {
      const state = collections.get(name);
      if (!state) {
        collections.set(name, { declared: true, majors: [now.schema], last: now });
        declaredHere.set(name, 1);
        continue;
      }
      if (isAdditive(state.last.schema, now.schema)) {
        state.majors[state.majors.length - 1] = now.schema;
      } else {
        state.majors.push(now.schema);
      }
      state.declared = true;
      state.last = now;
      declaredHere.set(name, state.majors.length);
    }
  }

  return {
    collections: new Map(
      [...collections].map(([name, { declared, majors }]) => [name, { declared, majors }])
    ),
    stepMajors,
  };
}

/** Every schema entity body of one app: each major of each collection its newest manifest declares. */
export function collectionSchemaDocuments(
  slug: string,
  derivation: MajorDerivation
): Array<{ urn: string; body: Record<string, unknown> }> {
  const out: Array<{ urn: string; body: Record<string, unknown> }> = [];
  for (const [collection, state] of derivation.collections) {
    if (!state.declared) continue;
    state.majors.forEach((declared, i) => {
      const major = i + 1;
      const urn = registryUrn({ kind: 'collection-schema', slug, collection, major });
      const successorUrn =
        major < state.majors.length
          ? registryUrn({ kind: 'collection-schema', slug, collection, major: major + 1 })
          : undefined;
      out.push({ urn, body: synthesizeCollectionSchema({ urn, declared, successorUrn }) });
    });
  }
  return out;
}
