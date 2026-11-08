/**
 * Collection schema MAJORS: which major each collection of an app is on, derived from the app's
 * approved manifest history, and the steps between consecutive majors. One implementation for
 * every consumer: the document store (which stamps each written document with its collection's
 * current major, `doc-store-schema-major.ts`) and the registry adapter (which publishes one
 * schema entity per major, `registry-adapter/collection-schema.ts`). They must agree on what
 * "major 3" is, so neither keeps its own copy of the rule.
 *
 * The rule for a major is the registry spec's, read literally (spec/registry.md @ 4166f34,
 * "Schemas": "A major version changes only additively: annotations and new optional properties.
 * Any other change is a new major"). So a major keeps a new optional property and any annotation
 * (at any depth); everything else mints, a widening included (an added `enum` value, a relaxed
 * bound, a dropped `required`), since the spec names only those two kinds as additive. That is
 * wider than the store's own "breaking" (narrowings only): it mints on every store-breaking
 * change, and on the widenings the store accepts in place.
 *
 * Pure: no database, no clock. The majors are recomputed from the history on every call.
 */
import { jsonEqual } from '~/server/services/apps/doc-store-schema';
import type { MigrationMutationOp } from '~/server/services/apps/storage-schema-migrations';
import {
  applyMigrationOps,
  checkStorageMigrations,
  isFieldDisallowed,
} from '~/server/services/apps/storage-schema-migrations';
import type {
  AppStorageCollectionSchema,
  DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';

/**
 * One step between consecutive majors (the registry's `x-migrateFrom` steps), paths as JSON
 * Pointers into the body.
 */
export type MigrateStep =
  | { op: 'default'; path: string; value: unknown }
  | { op: 'rename'; from: string; to: string }
  | { op: 'remove'; path: string };

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
 * optional properties (spec/registry.md, "Schemas"). `undefined` is a collection with no
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

/**
 * The store's ops for the transition that minted a major, as steps. The store runs only the ops
 * that cover a breaking change of that transition (`checkStorageMigrations`'s plan), so only
 * those are translated, in their declared order:
 *   - `default` and `rename` mean the same in both: fill a missing field; move a present field to
 *     an absent one.
 *   - `remove`: the store removes only a value the new schema refuses, the proposal's step
 *     unconditionally. They agree where the new schema refuses the field outright (a removed
 *     property), and only there is it translated. A `remove` covering a narrowing of a field the
 *     schema still allows is left out: a body whose value fits is then kept whole, and one whose
 *     value does not fails `@v{n+1}` and is not migrated, which never drops a valid value.
 *   - `acknowledge` changes nothing (the store refuses a violating document on its next write),
 *     so it has no step: a body that still violates the narrowing fails `@v{n+1}` after the
 *     steps, and the proposal says such a body is not migrated.
 */
export function migrateSteps(
  ops: readonly MigrationMutationOp[],
  newSchema: AppStorageCollectionSchema | undefined
): MigrateStep[] {
  const steps: MigrateStep[] = [];
  for (const op of ops) {
    if (op.op === 'default') steps.push({ op: 'default', path: op.path, value: op.value });
    else if (op.op === 'rename') steps.push({ op: 'rename', from: op.from, to: op.to });
    else if (isFieldDisallowed(newSchema, op.path)) steps.push({ op: 'remove', path: op.path });
  }
  return steps;
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
  /**
   * Per major, the steps from the one before it, translated from the transition that minted it
   * ({@link migrateSteps}); `null` for `@v1`. Fixed at the mint: later additive steps of the same
   * major never change them.
   */
  migrations: Array<MigrateStep[] | null>;
};

export type MajorDerivation = {
  collections: Map<string, CollectionMajors>;
  /** Step id → collection → the major that step's manifest declared it under. */
  stepMajors: Map<string, Map<string, number>>;
};

/**
 * Recompute every collection's majors from `steps`: the approved publish requests in review
 * order, then the enforced manifest ({@link manifestHistory} builds that list). A transition
 * mints the next major exactly when it is not {@link isAdditive}. That covers the store's own
 * breaking changes, an acknowledge-only one included: the store's breaking list
 * (`checkStorageMigrations`) is a subset of the non-additive changes, which the "store-breaking
 * ⇒ not additive" table in `registry-adapter/__tests__/collection-schema.test.ts` pins. A
 * collection removed and declared again is compared with its last declaration. A manifest whose
 * storage does not parse is skipped, as the store skips it.
 */
export function deriveCollectionMajors(steps: readonly ManifestStep[]): MajorDerivation {
  const collections = new Map<string, CollectionMajors & { last: DeclaredStorageCollection }>();
  const stepMajors = new Map<string, Map<string, number>>();
  // The manifests that parsed, oldest first: a mint's transition is from the last of them, and
  // the store finds a re-declared collection's last schema in the ones before (newest first).
  const parsedManifests: unknown[] = [];

  for (const step of steps) {
    // Every feature on: this replays APPROVED manifests for their shape, and a step must parse
    // whether or not a feature it used is switched on today. Whether a feature may ACT (such as
    // publishing a collection) is decided by the live switch where it acts (`doc-streams.ts`).
    const parsed = parseManifestStorage(step.manifest, APP_STORAGE_ALL_FEATURES_ON);
    const declaredHere = new Map<string, number>();
    stepMajors.set(step.id, declaredHere);
    if (parsed.errors.length > 0) continue;

    // The store's plan for this transition, computed only when a collection mints here.
    let plans: ReturnType<typeof checkStorageMigrations>['plans'] | null = null;
    const planFor = (name: string) => {
      plans ??= checkStorageMigrations(
        parsedManifests[parsedManifests.length - 1] ?? null,
        step.manifest,
        parsedManifests.slice(0, -1).reverse()
      ).plans;
      return plans.get(name) ?? [];
    };

    for (const state of collections.values()) state.declared = false;
    for (const [name, now] of parsed.collections) {
      const state = collections.get(name);
      if (!state) {
        collections.set(name, {
          declared: true,
          majors: [now.schema],
          migrations: [null],
          last: now,
        });
        declaredHere.set(name, 1);
        continue;
      }
      if (isAdditive(state.last.schema, now.schema)) {
        state.majors[state.majors.length - 1] = now.schema;
      } else {
        state.majors.push(now.schema);
        state.migrations.push(migrateSteps(planFor(name), now.schema));
      }
      state.declared = true;
      state.last = now;
      declaredHere.set(name, state.majors.length);
    }
    parsedManifests.push(step.manifest);
  }

  return {
    collections: new Map(
      [...collections].map(([name, { declared, majors, migrations }]) => [
        name,
        { declared, majors, migrations },
      ])
    ),
    stepMajors,
  };
}

/** One approved publish request of an app, as the history needs it. */
export type ApprovedManifest = { id: string; manifest: unknown; reviewedAt: Date | null };

/**
 * The steps {@link deriveCollectionMajors} replays for one app: its approved publish requests in
 * review order (`reviewedAt`, a missing one first, then id), then the enforced manifest
 * (`app_blocks.manifest`) as {@link HEAD_STEP}. The registry catalog read
 * (`registry-adapter/catalog-source.ts`, `readCatalog`) orders the same way; the agreement test
 * (`__tests__/storage-schema-majors.agreement.test.ts`) pins that both reach the same majors.
 */
export function manifestHistory(
  approved: readonly ApprovedManifest[],
  head: unknown
): ManifestStep[] {
  const ordered = [...approved].sort((a, b) => {
    const at = (a.reviewedAt?.getTime() ?? 0) - (b.reviewedAt?.getTime() ?? 0);
    return at !== 0 ? at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return [
    ...ordered.map((r) => ({ id: r.id, manifest: r.manifest })),
    { id: HEAD_STEP, manifest: head },
  ];
}

/**
 * Each collection the enforced manifest declares, with its current major: the major a document
 * written now is written under. A collection the enforced manifest does not declare (or one whose
 * storage does not parse) has none.
 */
export function currentCollectionMajors(derivation: MajorDerivation): ReadonlyMap<string, number> {
  return derivation.stepMajors.get(HEAD_STEP) ?? new Map();
}

/**
 * A body stored under major `from`, carried to major `to` (`from <= to`, both majors of
 * `collection`): each major's steps in turn, from `from + 1` through `to`, under that major's
 * schema. Returns a new body; `data` is not changed. `from === to` returns a copy unchanged.
 *
 * The steps are applied with the store's semantics (`applyMigrationOps`): `default` fills only a
 * missing field, `rename` moves only a present field to an absent one, and `remove` deletes only
 * a value the major's schema refuses, which for a translated `remove` (a property that schema no
 * longer allows, {@link migrateSteps}) is every value. So the chain is idempotent per major and
 * never touches a body already in the newer shape.
 *
 * Forward only. A read path returns a migrated body only where it calls this; any other read
 * returns the stored body.
 */
export function applyMajorChain(
  collection: Pick<CollectionMajors, 'majors' | 'migrations'>,
  data: Record<string, unknown>,
  from: number,
  to: number
): Record<string, unknown> {
  const count = collection.majors.length;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 1 ||
    to > count ||
    from > to
  ) {
    throw new RangeError(`no chain from major ${from} to major ${to} of ${count}`);
  }
  let body = structuredClone(data);
  for (let major = from + 1; major <= to; major++) {
    const steps = collection.migrations[major - 1] ?? [];
    body = applyMigrationOps(body, steps, collection.majors[major - 1]) ?? body;
  }
  return body;
}
