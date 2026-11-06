// App Storage SCHEMA MIGRATIONS — the static half: which collection-schema changes between an
// app's previous APPROVED version and a submitted one are BREAKING, which declared migration ops
// cover them, and what those ops do to one document. Pure: no database, no stored document is
// ever read (the diff is of the two declarations only). The declaration shape, and what each op
// means, is in `APP_STORAGE_MIGRATION_OPS` (`block-storage.constants.ts`); the run over stored
// documents is `storage-migration-run.service.ts`.
//
// BREAKING means "a document the old schema accepted may be refused by the new one", read per
// keyword — the full narrowing set:
//   - a property newly `required`;
//   - a declared property removed while `additionalProperties` is false (`properties`);
//   - `additionalProperties` newly false, or newly a schema over undeclared properties;
//   - `type` narrowed (a type removed; `number` → `integer` counts);
//   - `enum` / `const` narrowed (values removed, a `const` added or changed);
//   - `minimum`, `minLength`, `minItems` added or raised; `maximum`, `maxLength`, `maxItems`
//     added or lowered; `pattern` added or changed;
//   - any of these inside `properties`, `items` or an `additionalProperties` schema (recursing);
//   - a schema added to a collection that had none: "no schema" accepts anything, so the new
//     schema is diffed against `{}` and every constraint it adds is its own breaking change, at
//     its own (pointer, keyword) — each acknowledged one by one, each newly required field
//     filled by a `default`. The document root is always an object, so a root `type: "object"`
//     narrows nothing.
// A collection REMOVED from the manifest is not breaking: its documents are kept, unreachable, and
// reachable again if it is declared again. It is a submit WARNING.
// A keyword is only compared where the OLD schema let that type through (a `maxLength` on a field
// the old schema already held to numbers narrows nothing).
//
// 🔴 ONE DELIBERATE WIDENING OF THE RULE: a property an EXISTING schema did not declare, and that
// the new schema declares (optional), is not breaking even when the old schema left
// `additionalProperties` open — the author's previous schema did not describe the field, so the
// diff takes it that stored documents do not carry it. If the new schema also REQUIRES it, that
// is still a breaking `required` change. This exemption does not apply when the collection had
// no schema at all (above). It is reported as a submit WARNING naming the property, because stored
// documents may already hold that key with another type.
//
// Pointers in a breaking change are JSON Pointers into a document's `data`; the segment `*`
// stands for every array element (`items`) or every undeclared property (an
// `additionalProperties` schema).

import { firstSchemaFailure, jsonEqual } from '~/server/services/apps/doc-store-schema';
import type {
  AppStorageBreakingKeyword,
  AppStorageCollectionSchema,
  DeclaredStorageCollection,
  StorageMigrationOp,
} from '~/shared/constants/block-storage.constants';
import {
  APP_STORAGE_ALL_FEATURES_ON,
  APP_STORAGE_MIGRATION_ANY_SEGMENT,
  escapeJsonPointerSegment,
  jsonPointerCovers,
  jsonPointerSegments,
  parseManifestStorage,
} from '~/shared/constants/block-storage.constants';

export type BreakingChangeKeyword = AppStorageBreakingKeyword;

/** One breaking change: where, which keyword, and its old and new values (null when absent). */
export type BreakingChange = {
  collection: string;
  /** JSON Pointer into a document's `data`; `""` is the document itself. */
  pointer: string;
  keyword: BreakingChangeKeyword;
  old: unknown;
  new: unknown;
};

/** The ops that change a document — every op but `acknowledge`. */
export type MigrationMutationOp = Exclude<StorageMigrationOp, { op: 'acknowledge' }>;

export type StorageMigrationCheck = {
  /** Every breaking change of this transition, covered or not. */
  breaking: BreakingChange[];
  /** The breaking changes no op covers: submit refuses these. */
  uncovered: BreakingChange[];
  /** Declared ops that are wrong for the new schema (a `default` that does not match it): refused. */
  errors: string[];
  /**
   * Reported, never refused: ops that cover nothing in this transition (they never run), a
   * collection no longer declared, and a newly declared optional property on an open schema.
   */
  warnings: string[];
  /**
   * Collection → the mutation ops that cover at least one breaking change, in declared order:
   * what runs over the collection's stored documents when this version is approved.
   */
  plans: Map<string, MigrationMutationOp[]>;
};

type Node = Record<string, unknown>;
const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const ANY: Node = Object.freeze({}) as Node;

const child = (pointer: string, segment: string) =>
  `${pointer}/${escapeJsonPointerSegment(segment)}`;

const ALL_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** The declared types, or every type when `type` is absent. */
function typesOf(node: Node): string[] {
  if (node.type === undefined) return ALL_TYPES;
  return (Array.isArray(node.type) ? node.type : [node.type]) as string[];
}

/** Whether a schema with these types lets a value of type `t` through (`number` holds integers). */
function admits(types: string[], t: string): boolean {
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

/** What the old schema said about property `key`, which the new one declares. */
function oldPropertySchema(
  old: Node,
  key: string,
  hadSchema: boolean
): Node | 'disallowed' | 'undescribed' {
  const props = isObj(old.properties) ? old.properties : {};
  if (Object.hasOwn(props, key)) return props[key] as Node;
  if (old.additionalProperties === false) return 'disallowed';
  if (isObj(old.additionalProperties)) return old.additionalProperties;
  return hadSchema ? 'undescribed' : ANY;
}

type DiffSink = {
  /** Whether the collection had a schema before (see the exemption in the header). */
  hadSchema: boolean;
  push: (pointer: string, keyword: AppStorageBreakingKeyword, old: unknown, next: unknown) => void;
  /** A property newly declared on an open schema: exempt, but reported. */
  undescribed: (pointer: string) => void;
};

function diffNode(old: Node, next: Node, pointer: string, cx: DiffSink): void {
  const { hadSchema, push } = cx;
  const oldTypes = typesOf(old);
  const newTypes = typesOf(next);
  if (oldTypes.some((t) => !admits(newTypes, t))) {
    push(pointer, 'type', old.type ?? null, next.type);
  }

  if (Object.hasOwn(next, 'const')) {
    const same =
      (Object.hasOwn(old, 'const') && jsonEqual(old.const, next.const)) ||
      (Array.isArray(old.enum) && old.enum.every((v) => jsonEqual(v, next.const)));
    if (!same) {
      push(
        pointer,
        'const',
        Object.hasOwn(old, 'const') ? old.const : Array.isArray(old.enum) ? old.enum : null,
        next.const
      );
    }
  }
  if (Array.isArray(next.enum)) {
    const allowed = next.enum as unknown[];
    const before: unknown[] | null = Object.hasOwn(old, 'const')
      ? [old.const]
      : Array.isArray(old.enum)
      ? (old.enum as unknown[])
      : null;
    if (before === null || before.some((v) => !allowed.some((x) => jsonEqual(v, x)))) {
      push(pointer, 'enum', before, allowed);
    }
  }

  const could = (...types: string[]) => types.some((t) => admits(oldTypes, t));
  const lower = (keyword: 'minimum' | 'minLength' | 'minItems') => {
    const n = next[keyword];
    const o = old[keyword];
    if (typeof n === 'number' && !(typeof o === 'number' && n <= o)) {
      push(pointer, keyword, o ?? null, n);
    }
  };
  const upper = (keyword: 'maximum' | 'maxLength' | 'maxItems') => {
    const n = next[keyword];
    const o = old[keyword];
    if (typeof n === 'number' && !(typeof o === 'number' && n >= o)) {
      push(pointer, keyword, o ?? null, n);
    }
  };
  if (could('string')) {
    lower('minLength');
    upper('maxLength');
    if (typeof next.pattern === 'string' && next.pattern !== old.pattern) {
      push(pointer, 'pattern', old.pattern ?? null, next.pattern);
    }
  }
  if (could('number', 'integer')) {
    lower('minimum');
    upper('maximum');
  }
  if (could('array')) {
    lower('minItems');
    upper('maxItems');
    if (isObj(next.items)) {
      diffNode(
        isObj(old.items) ? old.items : ANY,
        next.items,
        `${pointer}/${APP_STORAGE_MIGRATION_ANY_SEGMENT}`,
        cx
      );
    }
  }
  if (!could('object')) return;

  const oldRequired = new Set(Array.isArray(old.required) ? (old.required as string[]) : []);
  for (const key of Array.isArray(next.required) ? (next.required as string[]) : []) {
    if (!oldRequired.has(key)) push(child(pointer, key), 'required', false, true);
  }

  const oldProps = isObj(old.properties) ? old.properties : {};
  const newProps = isObj(next.properties) ? next.properties : {};
  const oldAp = old.additionalProperties;
  const newAp = next.additionalProperties;
  if (newAp === false && oldAp !== false) {
    push(pointer, 'additionalProperties', oldAp ?? null, false);
  }
  for (const key of Object.keys(newProps)) {
    const before = oldPropertySchema(old, key, hadSchema);
    if (before === 'undescribed') cx.undescribed(child(pointer, key));
    if (before === 'disallowed' || before === 'undescribed') continue;
    diffNode(before, newProps[key] as Node, child(pointer, key), cx);
  }
  for (const key of Object.keys(oldProps)) {
    if (Object.hasOwn(newProps, key)) continue;
    // A declared property the new schema no longer declares: refused outright, or held to the
    // new `additionalProperties` schema.
    if (newAp === false) push(child(pointer, key), 'properties', 'declared', 'removed');
    else if (isObj(newAp)) diffNode(oldProps[key] as Node, newAp, child(pointer, key), cx);
  }
  if (isObj(newAp) && oldAp !== false) {
    diffNode(
      isObj(oldAp) ? oldAp : ANY,
      newAp,
      `${pointer}/${APP_STORAGE_MIGRATION_ANY_SEGMENT}`,
      cx
    );
  }
}

/** What one collection's schema change does: the breaking changes, and the exempt new properties. */
export type CollectionSchemaDiff = {
  breaking: BreakingChange[];
  /** Pointers of properties newly declared (optional) on a schema that left undeclared keys open. */
  undescribed: string[];
};

/** The breaking changes between two collection schemas (`undefined` = no schema), with notes. */
export function diffCollectionSchemasWithNotes(
  collection: string,
  oldSchema: AppStorageCollectionSchema | undefined,
  newSchema: AppStorageCollectionSchema | undefined
): CollectionSchemaDiff {
  const out: CollectionSchemaDiff = { breaking: [], undescribed: [] };
  if (!newSchema) return out;
  // A stored document is always a JSON object (the store refuses anything else), so at the root
  // the old schema held objects only, whatever it declared: a root `type: "object"` narrows
  // nothing, and no non-object keyword at the root can either.
  const root = { ...((oldSchema ?? ANY) as Node), type: 'object' };
  diffNode(root, newSchema as Node, '', {
    hadSchema: oldSchema !== undefined,
    push: (pointer, keyword, old, next) =>
      out.breaking.push({
        collection,
        pointer,
        keyword,
        old: pointer === '' && keyword === 'type' ? oldSchema?.type ?? null : old,
        new: next,
      }),
    undescribed: (pointer) => out.undescribed.push(pointer),
  });
  return out;
}

/** The breaking changes between two collection schemas (`undefined` = no schema). */
export function diffCollectionSchemas(
  collection: string,
  oldSchema: AppStorageCollectionSchema | undefined,
  newSchema: AppStorageCollectionSchema | undefined
): BreakingChange[] {
  return diffCollectionSchemasWithNotes(collection, oldSchema, newSchema).breaking;
}

/**
 * The sub-schema a field is held to under `schema`: the declared property, or the
 * `additionalProperties` schema, walking `segments`. `'disallowed'` when the field is refused
 * outright; `{}` when nothing describes it (it is accepted as anything).
 */
function fieldSchema(schema: Node, segments: string[]): Node | 'disallowed' {
  let node = schema;
  for (const seg of segments) {
    const props = isObj(node.properties) ? node.properties : {};
    if (Object.hasOwn(props, seg)) node = props[seg] as Node;
    else if (isObj(node.additionalProperties)) node = node.additionalProperties;
    else if (node.additionalProperties === false) return 'disallowed';
    else return ANY;
  }
  return node;
}

/**
 * Whether `schema` refuses the field `pointer` names outright, whatever its value (it, or an
 * object on its path, is not allowed under `additionalProperties: false`). A `remove` there drops
 * every value, so it equals an unconditional remove; the registry adapter's `x-migrateFrom`
 * relies on that.
 */
export function isFieldDisallowed(
  schema: AppStorageCollectionSchema | undefined,
  pointer: string
): boolean {
  if (!schema) return false;
  return fieldSchema(schema as Node, jsonPointerSegments(pointer)) === 'disallowed';
}

/** Whether the new schema requires the field `path` names in its parent object. */
function requiredIn(schema: Node | undefined, path: string): boolean {
  if (!schema) return false;
  const segments = jsonPointerSegments(path);
  if (segments.length === 0) return false;
  const parent = fieldSchema(schema, segments.slice(0, -1));
  return (
    parent !== 'disallowed' &&
    Array.isArray(parent.required) &&
    (parent.required as string[]).includes(segments[segments.length - 1])
  );
}

/**
 * THE coverage rule: whether `op` covers `change` (both in the same collection).
 *   - `acknowledge` — exactly the change at its `path` with its `keyword` (never `required`: the
 *     parser refuses that, and a newly required field is covered only by a `default`).
 *   - `default` — a newly `required` property, at exactly its pointer.
 *   - `rename` — a declared property removed under `additionalProperties: false`, at `from`.
 *   - `remove` — any change at or under the removed field, unless the new schema requires the
 *     field (removing it would then break `required` instead).
 */
export function migrationOpCovers(
  op: StorageMigrationOp,
  change: BreakingChange,
  newSchema: AppStorageCollectionSchema | undefined
): boolean {
  switch (op.op) {
    case 'acknowledge':
      return (
        change.keyword !== 'required' && op.keyword === change.keyword && op.path === change.pointer
      );
    case 'default':
      return change.keyword === 'required' && op.path === change.pointer;
    case 'rename':
      return change.keyword === 'properties' && op.from === change.pointer;
    case 'remove':
      return jsonPointerCovers(op.path, change.pointer) && !requiredIn(newSchema as Node, op.path);
  }
}

function opLabel(name: string, index: number): string {
  return `storage.collections.${name}.migrations[${index}]`;
}

/**
 * THE check, at submit and again at approve: diff the storage the app has now against the
 * submitted one and match every breaking change to the ops that cover it.
 *
 * `prev` is the BASELINE — what the store enforces today (`app_blocks.manifest`), or null for a
 * first version, which has nothing to break. `history` is the app's earlier approved manifests,
 * newest first: a collection the baseline does not declare but the submission does is diffed
 * against the most recent of them that declared it, so a collection dropped and later declared
 * again is compared with the schema its stored documents were written under. A collection no
 * manifest ever declared is new and has nothing stored.
 *
 * A manifest whose `storage` does not parse yields an empty check: the manifest validator
 * reports those errors itself, and a baseline that does not parse cannot be compared (a warning
 * says so; an unparseable `history` entry is skipped).
 */
export function checkStorageMigrations(
  prev: unknown,
  next: unknown,
  history: readonly unknown[] = []
): StorageMigrationCheck {
  const check: StorageMigrationCheck = {
    breaking: [],
    uncovered: [],
    errors: [],
    warnings: [],
    plans: new Map(),
  };
  const after = parseManifestStorage(next, APP_STORAGE_ALL_FEATURES_ON);
  if (after.errors.length > 0) return check;
  const before = prev === null ? null : parseManifestStorage(prev, APP_STORAGE_ALL_FEATURES_ON);
  if (before && before.errors.length > 0) {
    check.warnings.push(
      'storage: the previous approved version declares storage that no longer parses, so its collection schemas were not compared with this version'
    );
  }
  const prevCollections: ReadonlyMap<string, DeclaredStorageCollection> =
    before && before.errors.length === 0 ? before.collections : new Map();

  const compare = (
    name: string,
    was: DeclaredStorageCollection,
    now: DeclaredStorageCollection
  ) => {
    const diff = diffCollectionSchemasWithNotes(name, was.schema, now.schema);
    check.breaking.push(...diff.breaking);
    for (const pointer of diff.undescribed) {
      check.warnings.push(
        `storage.collections.${name}: ${JSON.stringify(
          pointer
        )} is newly declared on a schema that left undeclared properties open — stored documents may already hold this key with another type, and those are refused on their next write`
      );
    }
  };

  for (const [name, was] of prevCollections) {
    const now = after.collections.get(name);
    if (!now) {
      check.warnings.push(
        `storage: collection ${name} is no longer declared; its stored documents are kept and become reachable again if it is re-declared`
      );
      continue;
    }
    compare(name, was, now);
  }

  // Declared again after an earlier version dropped it: its documents were written under the
  // last schema that declared it.
  let older: ReadonlyMap<string, DeclaredStorageCollection>[] | null = null;
  for (const [name, now] of after.collections) {
    if (prevCollections.has(name)) continue;
    older ??= history
      .map((m) => parseManifestStorage(m, APP_STORAGE_ALL_FEATURES_ON))
      .filter((h) => h.errors.length === 0)
      .map((h) => h.collections);
    const was = older.find((c) => c.has(name))?.get(name);
    if (was) compare(name, was, now);
  }

  const used = new Map<string, Set<number>>();
  for (const change of check.breaking) {
    const collection = after.collections.get(change.collection);
    const ops = collection?.migrations ?? [];
    let covered = false;
    ops.forEach((op, i) => {
      if (!migrationOpCovers(op, change, collection?.schema)) return;
      covered = true;
      let set = used.get(change.collection);
      if (!set) used.set(change.collection, (set = new Set()));
      set.add(i);
    });
    if (!covered) check.uncovered.push(change);
  }

  for (const [name, collection] of after.collections) {
    const ops = collection.migrations ?? [];
    const usedHere = used.get(name) ?? new Set<number>();
    const plan: MigrationMutationOp[] = [];
    ops.forEach((op, i) => {
      if (!usedHere.has(i)) {
        check.warnings.push(
          `${opLabel(name, i)} (${
            op.op
          }) covers no breaking change between the previous approved version and this one, so it will not run — remove it from the manifest`
        );
      } else if (op.op !== 'acknowledge') {
        plan.push(op);
      }
    });
    if (plan.length > 0) check.plans.set(name, plan);

    // What a mutation op writes must be what the new schema accepts there.
    const schema = collection.schema as Node | undefined;
    if (!schema) continue;
    ops.forEach((op, i) => {
      if (op.op === 'default') {
        const target = fieldSchema(schema, jsonPointerSegments(op.path));
        if (target === 'disallowed') {
          check.errors.push(
            `${opLabel(name, i)}.path ${JSON.stringify(
              op.path
            )} is a field the new schema does not allow, so the default would make every document it fills invalid`
          );
          return;
        }
        const failure = firstSchemaFailure(target as AppStorageCollectionSchema, op.value);
        if (failure) {
          check.errors.push(
            `${opLabel(name, i)}.value does not match the new schema at ${JSON.stringify(
              op.path + failure.pointer
            )}: ${failure.reason}`
          );
        }
      } else if (op.op === 'rename') {
        if (fieldSchema(schema, jsonPointerSegments(op.to)) === 'disallowed') {
          check.errors.push(
            `${opLabel(name, i)}.to ${JSON.stringify(
              op.to
            )} is a field the new schema does not allow, so the rename would make every document it moves invalid`
          );
        }
      }
    });
  }
  return check;
}

const MAX_LISTED = 20;
const shown = (v: unknown) => {
  if (v === null || v === undefined) return '(none)';
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

/** One breaking change as a line of the refusal. */
export function describeBreakingChange(c: BreakingChange): string {
  const where = c.pointer === '' ? '(the document root)' : JSON.stringify(c.pointer);
  return `${c.collection} ${where} ${c.keyword}: ${shown(c.old)} → ${shown(c.new)}`;
}

/**
 * The submit / approve refusal. `breaking` is the structured list (collection, pointer, keyword,
 * old → new) the submit routes return beside the message.
 */
export class StorageMigrationRefusal extends Error {
  readonly breaking: BreakingChange[];
  readonly migrationErrors: string[];
  constructor(check: Pick<StorageMigrationCheck, 'uncovered' | 'errors'>) {
    const parts: string[] = [];
    if (check.uncovered.length > 0) {
      const listed = check.uncovered.slice(0, MAX_LISTED).map(describeBreakingChange);
      if (check.uncovered.length > MAX_LISTED) {
        listed.push(`…and ${check.uncovered.length - MAX_LISTED} more`);
      }
      parts.push(
        `storage: ${
          check.uncovered.length
        } breaking schema change(s) since the previous approved version can leave documents already stored unwritable, and no migration covers them: ${listed.join(
          '; '
        )}. For each, declare an op under storage.collections.<name>.migrations — "default" for a newly required field, "rename" or "remove" for a removed one, or "acknowledge" with the change's exact path and keyword to accept that stored documents violating it are refused on their next write until reshaped (a newly required field needs a "default"). A newly required object together with a newly required field inside it takes two versions: first require the object with a "default" whose value already holds the field, then require the field with its own "default". A newly required field inside an array element or an additionalProperties schema ("…/*/…") cannot be filled by any op: declare it optional, or "remove" the whole optional array or object`
      );
    }
    parts.push(...check.errors.slice(0, MAX_LISTED));
    super(parts.join('. '));
    this.name = 'StorageMigrationRefusal';
    this.breaking = check.uncovered;
    this.migrationErrors = check.errors;
  }
}

export function isStorageMigrationRefusal(err: unknown): err is StorageMigrationRefusal {
  return err instanceof StorageMigrationRefusal;
}

/** Throws {@link StorageMigrationRefusal} when the check has anything to refuse. */
export function assertStorageMigrationsCover(check: StorageMigrationCheck): void {
  if (check.uncovered.length > 0 || check.errors.length > 0) {
    throw new StorageMigrationRefusal(check);
  }
}

// ---------------------------------------------------------------------------
// Whether two manifests declare one collection's STORAGE alike
// ---------------------------------------------------------------------------

/** The declaration fields whose change can affect how a collection's stored documents migrate. */
export const COLLECTION_STORAGE_FIELDS = [
  'schema',
  'migrations',
  'visibility',
  'write',
  'exportable',
] as const;

/**
 * JSON with object keys sorted at every depth, so equal values compare equal as text. Not
 * `stableJsonStringify` (publish-request.service.ts): that is private to a module this pure one must
 * not import, and it prints a top-level `undefined` as `undefined`, where this prints `null`.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObj(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A comparable key of how `manifest` declares `collection`'s storage — {@link
 * COLLECTION_STORAGE_FIELDS} of its raw declaration, or `null` when it is not declared. Two
 * manifests with the same key leave that collection's stored documents, and a migration over
 * them, untouched.
 */
export function collectionStorageKey(manifest: unknown, collection: string): string | null {
  const collections = (manifest as { storage?: { collections?: unknown } } | null)?.storage
    ?.collections;
  if (!isObj(collections) || !Object.hasOwn(collections, collection)) return null;
  const decl = collections[collection];
  if (!isObj(decl)) return stableJson(decl);
  return stableJson(Object.fromEntries(COLLECTION_STORAGE_FIELDS.map((f) => [f, decl[f] ?? null])));
}

// ---------------------------------------------------------------------------
// Applying ops to one document
// ---------------------------------------------------------------------------

/** The object holding the field `segments` names, or null when a step is missing or not an object. */
function parentOf(root: Node, segments: string[]): Node | null {
  let cur: unknown = root;
  for (const seg of segments.slice(0, -1)) {
    if (!isObj(cur) || !Object.hasOwn(cur, seg)) return null;
    cur = cur[seg];
  }
  return isObj(cur) ? cur : null;
}

/** An own data property, never a prototype setter (`__proto__` is an ordinary key in JSON). */
function setOwn(obj: Node, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Whether the value at `segments` must go for the document to match `schema`: the new schema no
 * longer allows the key there, or the value fails the schema it is held to there. Without a
 * schema nothing is refused, so nothing must go.
 */
function failsNewSchema(
  schema: AppStorageCollectionSchema | undefined,
  segments: string[],
  value: unknown
): boolean {
  if (!schema) return false;
  const target = fieldSchema(schema as Node, segments);
  if (target === 'disallowed') return true;
  return firstSchemaFailure(target as AppStorageCollectionSchema, value) !== null;
}

/**
 * Apply the mutation ops, in order, to a copy of `data`, for a collection whose (new) schema is
 * `schema`. Returns the new body, or null when no op changed anything.
 *
 * Each op acts only on a document still in the OLD shape, so it never undoes a write made under
 * the new schema — the run reaches a document hours after approve, and the new build (or an old
 * client still writing valid values) may have written it in between:
 *   - `default` fills a field only when it is missing; under the new schema the field is required,
 *     so a new-shape write always carries it.
 *   - `rename` moves only when `from` is present and `to` absent; it covers only a property the new
 *     schema refuses (`additionalProperties: false`), so no new-shape write can carry `from`.
 *   - `remove` deletes only a value the new schema refuses there (the key is no longer allowed, or
 *     the value fails the field's new schema). A value valid under the new schema is kept.
 *
 * IDEMPOTENT: `apply(apply(d)) == apply(d)` — each op's precondition is false in the state it leaves
 * behind, and the parser keeps the ops' fields disjoint so none undoes another. A step that meets a
 * missing parent, or a non-object where an object is expected, does nothing.
 */
export function applyMigrationOps(
  data: Record<string, unknown>,
  ops: readonly MigrationMutationOp[],
  schema: AppStorageCollectionSchema | undefined
): Record<string, unknown> | null {
  const doc = structuredClone(data) as Node;
  let changed = false;
  for (const op of ops) {
    if (op.op === 'default') {
      const segments = jsonPointerSegments(op.path);
      const parent = parentOf(doc, segments);
      const key = segments[segments.length - 1];
      if (parent && !Object.hasOwn(parent, key)) {
        setOwn(parent, key, structuredClone(op.value));
        changed = true;
      }
    } else if (op.op === 'rename') {
      const from = jsonPointerSegments(op.from);
      const to = jsonPointerSegments(op.to);
      const src = parentOf(doc, from);
      const dst = parentOf(doc, to);
      const fromKey = from[from.length - 1];
      const toKey = to[to.length - 1];
      if (src && dst && Object.hasOwn(src, fromKey) && !Object.hasOwn(dst, toKey)) {
        setOwn(dst, toKey, src[fromKey]);
        delete src[fromKey];
        changed = true;
      }
    } else {
      const segments = jsonPointerSegments(op.path);
      const parent = parentOf(doc, segments);
      const key = segments[segments.length - 1];
      // The guard that keeps a value written under the new schema (see above).
      if (parent && Object.hasOwn(parent, key) && failsNewSchema(schema, segments, parent[key])) {
        delete parent[key];
        changed = true;
      }
    }
  }
  return changed ? doc : null;
}
