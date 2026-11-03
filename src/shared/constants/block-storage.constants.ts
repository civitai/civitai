/**
 * App Blocks APP STORAGE — the manifest-declared `storage` contract (the document store
 * that replaces the per-viewer `kv` store and the `shared_kv` feed). Pure and client-safe:
 * no server imports (the manifest validator that imports it is client-bundle-safe).
 *
 * An app declares, in its reviewed manifest, every COLLECTION it stores documents in and,
 * per collection, who can read it (`visibility`), who can write it (`write`), the counters
 * and marks it keeps and the fields it can be filtered or sorted by. Nothing is created
 * implicitly at runtime: the visibility and write policy are what a moderator has to see,
 * and the platform can only enforce what is written down.
 *
 * Every bound below is mirrored in `public/schemas/app-block/v1.json` (the published
 * manifest schema); `manifest-storage.schema-drift.test.ts` pins the two together, both
 * structurally and by evaluating one table of declarations against each.
 *
 * 🔴 THE SCHEMA CARRIES THE WHOLE SHAPE, THIS MODULE ALSO DECIDES WHAT IS SWITCHED ON. The
 * canonical schema is byte-mirrored into the CLI and the SDK, and each mirror can only be
 * synced after the canonical copy is live, so the full shape (including log collections,
 * TTL and owner-written documents) lands in the schema once. Features that are not built
 * yet are refused HERE, by {@link APP_STORAGE_ENABLED_FEATURES}, with a message that says
 * so. Turning one on later is a one-line change to that object and no schema change.
 */

import { boundedManifestParse } from './manifest-bounded-parse';

/** The scope every app that declares a collection must request. Consent-exempt. */
export const APP_STORAGE_BASE_SCOPE = 'apps:storage';
/**
 * The scope that lets a viewer create or edit documents OTHER viewers read, under the
 * viewer's own identity. Sensitive (needs a `scopeJustifications` entry) and consent-gated.
 */
export const APP_STORAGE_PUBLISH_SCOPE = 'apps:storage:publish';
/**
 * The scope that lets an app read (and, with `access: "readwrite"`, write) the viewer's data in
 * ANOTHER app, as that viewer, through the imports it declares in `storage.imports`. Sensitive
 * (needs a `scopeJustifications` entry) and consent-gated; the grant is recorded per (viewer,
 * consumer app, source app) with the collections and access the prompt showed — see
 * `storage-import-grant.service.ts`. It is not publish consent in the source: a write to one of
 * the source's shared collections also needs the viewer's own {@link APP_STORAGE_PUBLISH_SCOPE}
 * there.
 */
export const APP_STORAGE_IMPORT_SCOPE = 'apps:storage:import';

/** Collection names. The length lives in the regex so the schema key equals its `.source`. */
export const APP_STORAGE_COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Most collections one app may declare. */
export const APP_STORAGE_MAX_COLLECTIONS = 16;

/**
 * `storage.imports`: the collections of OTHER apps this app reads or writes as the viewer.
 * `from` is the source app's `blockId` — its slug, the one public app identifier that is unique
 * (`app_blocks_block_id_unique`) and stable across versions (the database id of a block row is
 * not public, and an OAuth client id changes on re-approval). Same rule as the manifest's own
 * `blockId`. At most {@link APP_STORAGE_MAX_IMPORTS} imports, one per source app, each naming 1
 * to {@link APP_STORAGE_MAX_IMPORT_COLLECTIONS} of the source's collections (the most a source
 * can declare, so a fork can import every collection of its parent).
 */
export const APP_STORAGE_MAX_IMPORTS = 8;
export const APP_STORAGE_MAX_IMPORT_COLLECTIONS = 16;
export const APP_STORAGE_IMPORT_FROM_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const APP_STORAGE_IMPORT_ACCESS = ['read', 'readwrite'] as const;
export type AppStorageImportAccess = (typeof APP_STORAGE_IMPORT_ACCESS)[number];

/** Counter and mark names — the same rule as a collection name. */
export const APP_STORAGE_TALLY_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
/** Most counters one collection may declare. */
export const APP_STORAGE_MAX_COUNTERS = 8;
/** Most marks one collection may declare (built-in marks do not count). */
export const APP_STORAGE_MAX_MARKS = 8;

/**
 * Marks every shared collection has without declaring them. `report` feeds moderation, so
 * an app neither declares it nor reads its count. Declaring one is refused, and so is a
 * COUNTER of the same name — a counter and a mark of one name would be two different
 * tallies a reader can confuse.
 */
export const APP_STORAGE_BUILTIN_MARKS: readonly string[] = ['report'];

/**
 * An index name IS the path of the field it indexes inside a document's `data`: up to
 * {@link APP_STORAGE_INDEX_MAX_DEPTH} segments joined by `.`, each a letter followed by up
 * to 31 letters, digits or `_` (so `status`, `datasetId`, `meta.round`). Case is allowed
 * because app data uses camelCase field names. No array indexing, no escaping: a field
 * whose name contains `.` cannot be indexed.
 */
export const APP_STORAGE_INDEX_MAX_DEPTH = 3;
export const APP_STORAGE_INDEX_PATH_RE =
  /^[A-Za-z][A-Za-z0-9_]{0,31}(\.[A-Za-z][A-Za-z0-9_]{0,31}){0,2}$/;
/** Most indexes one collection may declare. */
export const APP_STORAGE_MAX_INDEXES = 4;
export const APP_STORAGE_INDEX_TYPES = ['string', 'number', 'boolean', 'time'] as const;
export type AppStorageIndexType = (typeof APP_STORAGE_INDEX_TYPES)[number];
/**
 * Index names that would collide with a built-in sort key (`sort=key|createdAt|updatedAt`).
 * A query naming one of these sorts by the built-in, so an index of that name could never
 * be used.
 */
export const APP_STORAGE_RESERVED_INDEX_NAMES: readonly string[] = [
  'key',
  'createdAt',
  'updatedAt',
];

export const APP_STORAGE_KINDS = ['docs', 'log'] as const;
export type AppStorageKind = (typeof APP_STORAGE_KINDS)[number];
export const APP_STORAGE_VISIBILITIES = ['private', 'shared'] as const;
export type AppStorageVisibility = (typeof APP_STORAGE_VISIBILITIES)[number];
/**
 * Who may create, update and delete documents in a SHARED collection:
 *   - `own`    — eligible viewers create; only a document's author updates or deletes it.
 *   - `anyone` — eligible viewers may update or delete any document (later phase; see the
 *                feature switch).
 *   - `owner`  — only the app owner writes documents (later phase; see the feature switch).
 *   - `none`   — nobody creates, updates or deletes documents. Viewers may only increment
 *                the declared counters and set the declared marks; incrementing a counter
 *                on a document that does not exist creates an empty one authored by nobody.
 *                For tallies keyed by something outside the store (plays per item, votes
 *                per model) — no viewer publishes anything, so no publish scope or prompt.
 */
export const APP_STORAGE_WRITE_POLICIES = ['own', 'anyone', 'owner', 'none'] as const;
export type AppStorageWritePolicy = (typeof APP_STORAGE_WRITE_POLICIES)[number];

/** `ttlSeconds` bounds: one minute to 365 days. */
export const APP_STORAGE_TTL_MIN_SECONDS = 60;
export const APP_STORAGE_TTL_MAX_SECONDS = 31_536_000;
/** `maxEntries` (log collections) bounds. */
export const APP_STORAGE_LOG_MAX_ENTRIES = 10_000;
/** `dailyWritesPerAuthor` bounds. */
export const APP_STORAGE_MAX_DAILY_WRITES_PER_AUTHOR = 1_000;

/**
 * `ownedModelVersions` entries: pointers into a document's `data`, checked on every create and
 * update (`doc-store-ownership.ts`). 1 to 4 plain identifier segments, so a pointer names
 * exactly one field: no array indexes (which would check one element and leave the others
 * unchecked), no escapes. A string, not a `RegExp`, because the schema's `pattern` must equal
 * it byte for byte and `RegExp.source` escapes `/`.
 */
export const APP_STORAGE_OWNED_POINTER_PATTERN = '^(/[A-Za-z_][A-Za-z0-9_]{0,63}){1,4}$';
export const APP_STORAGE_OWNED_POINTER_RE = new RegExp(APP_STORAGE_OWNED_POINTER_PATTERN, 'u');
/** Most pointers one collection may declare in `ownedModelVersions`. */
export const APP_STORAGE_MAX_OWNED_MODEL_VERSIONS = 4;
/**
 * The write policies of a SHARED collection under which `ownedModelVersions` may be declared:
 * the ones where the viewer making a write is always the document's author. Under `anyone` a
 * viewer could put their own version into another viewer's document; under `owner` and `none`
 * no viewer writes `data` at all. Private collections have no readers to mislead.
 */
export const APP_STORAGE_OWNED_MODEL_VERSIONS_WRITE_POLICIES: readonly AppStorageWritePolicy[] = [
  'own',
];

/**
 * COLLECTION SCHEMAS (`schema`): an opt-in JSON Schema SUBSET that every document's `data` in
 * the collection must match, checked by the store on every create and update (never on
 * counters or marks; `doc-store-schema.ts`). Only these keywords exist; any other is refused
 * by name, so a keyword the store would silently ignore can never read as enforced.
 *
 * Semantics (shared with every other evaluator of the subset, the CLI's included): keywords
 * that do not apply to a value's type are ignored (draft 2020-12); `integer` is a number with
 * no fraction and `number` includes it; string lengths count code points; `pattern` is an
 * ECMAScript regular expression with the `u` flag, unanchored; `enum` and `const` compare by
 * JSON value; `items` is one schema for every element; `required` and `additionalProperties`
 * use own keys only.
 */
export const APP_STORAGE_SCHEMA_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'description',
] as const;
export const APP_STORAGE_SCHEMA_TYPES = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
] as const;
export type AppStorageSchemaType = (typeof APP_STORAGE_SCHEMA_TYPES)[number];
/** A collection schema as declared: a JSON object whose keywords are the subset above. */
export type AppStorageCollectionSchema = { readonly [keyword: string]: unknown };
/**
 * Most schemas nested inside one another, the collection's own schema counting as 1 (each
 * `properties` entry, `items` and `additionalProperties` schema is one level deeper).
 */
export const APP_STORAGE_SCHEMA_MAX_DEPTH = 16;
/** Most bytes of one collection schema, as UTF-8 JSON (`JSON.stringify`, no whitespace). */
export const APP_STORAGE_SCHEMA_MAX_BYTES = 16 * 1024;
/** Longest `pattern` source, in code points (as JSON Schema's `maxLength` counts). */
export const APP_STORAGE_SCHEMA_PATTERN_MAX_LENGTH = 256;
/**
 * A schema with a `pattern` must also declare `maxLength` of at most this, so a stored pattern
 * only ever runs against a bounded string (the store checks `maxLength` before `pattern`). The
 * submit gate also refuses a pattern that can backtrack catastrophically (recheck), which input
 * length alone cannot bound. The same ceiling as a manifest setting's patterned input.
 */
export const APP_STORAGE_SCHEMA_PATTERNED_MAX_LENGTH = 1000;
/** Most `pattern`s one collection schema may declare: each costs a ReDoS analysis at submit. */
export const APP_STORAGE_SCHEMA_MAX_PATTERNS = 16;
/**
 * Most `pattern`s all of a manifest's collection schemas may declare together. Each distinct
 * one costs a ReDoS analysis at submit that blocks the event loop (up to about a second for a
 * long pattern), so without this a manifest could queue 16 collections × 16 patterns.
 */
export const APP_STORAGE_MANIFEST_MAX_PATTERNS = 32;
/**
 * The flags a collection schema's `pattern` is compiled with, by the store and the parser,
 * and analysed with by the submit-time ReDoS gate. One constant, so the gate can never read a
 * pattern differently from how it runs.
 */
export const APP_STORAGE_SCHEMA_PATTERN_FLAGS = 'u';

/**
 * Most errors one parse reports; the rest are summarised in one final line. The errors are
 * joined into the submit response, so without a cap a crafted manifest can turn into a
 * multi-megabyte error message.
 */
export const APP_STORAGE_MAX_ERRORS = 20;

/** The storage features that ship in later phases than the declaration itself. */
export type AppStorageFeature =
  | 'anyoneWrites'
  | 'ownerWrites'
  | 'logCollections'
  | 'ttl'
  | 'perAuthorWriteBudget';

/**
 * 🔴 THE ONE SWITCH for which declared storage features the platform accepts. Everything
 * in the `storage` schema that is not listed here is available now. Each entry is refused
 * by {@link parseManifestStorage} while it is `false`:
 *
 *   - `anyoneWrites`   — `write: "anyone"` (any eligible viewer edits or deletes any document).
 *   - `ownerWrites`    — `write: "owner"` (documents written by the app owner, not viewers).
 *   - `logCollections` — `kind: "log"` (append-only, trimmed to `maxEntries`).
 *   - `ttl`            — `ttlSeconds` (documents that expire).
 *   - `perAuthorWriteBudget` — `dailyWritesPerAuthor` (a per-collection daily write budget
 *                      in place of the platform default; the storage routes do not read it
 *                      yet, so a declared limit must not read as working).
 *
 * Flip one only in the same change that ships the runtime behind it: an accepted
 * declaration with nothing behind it reads as a working feature to the author and the
 * reviewer alike.
 */
export const APP_STORAGE_ENABLED_FEATURES: Readonly<Record<AppStorageFeature, boolean>> =
  Object.freeze({
    anyoneWrites: false,
    ownerWrites: false,
    logCollections: false,
    ttl: false,
    perAuthorWriteBudget: false,
  });

export type DeclaredStorageCollection = {
  kind: AppStorageKind;
  visibility: AppStorageVisibility;
  /** Present on shared collections only. */
  write?: AppStorageWritePolicy;
  counters: readonly string[];
  marks: readonly string[];
  indexes: ReadonlyMap<string, AppStorageIndexType>;
  showAuthor: boolean;
  ttlSeconds?: number;
  maxEntries?: number;
  dailyWritesPerAuthor?: number;
  /** JSON Pointers into `data` that must name the author's own model versions. */
  ownedModelVersions?: readonly string[];
  /**
   * Whether another app may reach this collection through `storage.imports`. Default true (opt
   * out); absent reads as exportable ({@link isCollectionExportable}).
   */
  exportable?: boolean;
  /**
   * The schema every document's `data` must match, exactly as declared (validated by
   * {@link parseCollectionSchema}). Absent: documents are not checked.
   */
  schema?: AppStorageCollectionSchema;
};

/** Whether another app may reach this collection through an import. */
export function isCollectionExportable(collection: DeclaredStorageCollection): boolean {
  return collection.exportable !== false;
}

/** One declared import: which of the source app's collections, and how. */
export type DeclaredStorageImport = {
  /** The source app's blockId. */
  from: string;
  collections: ReadonlySet<string>;
  access: AppStorageImportAccess;
};

/** Source blockId → its import. A `Map` for the same reason as the collections map. */
export type DeclaredStorageImports = ReadonlyMap<string, DeclaredStorageImport>;

/**
 * Collection name → declaration.
 *
 * 🔴 A `Map`, NOT A PLAIN OBJECT, for the same reason as `DeclaredEvents` in
 * `block-analytics.constants.ts`: the name pattern admits `constructor`, and a plain-object
 * lookup of an undeclared `constructor` returns `Object.prototype.constructor`.
 */
export type DeclaredStorageCollections = ReadonlyMap<string, DeclaredStorageCollection>;

export type ParsedManifestStorage = {
  /** True when the manifest has a `storage` key at all, valid or not. */
  declared: boolean;
  collections: DeclaredStorageCollections;
  imports: DeclaredStorageImports;
  errors: string[];
};

const STORAGE_KEYS = new Set(['collections', 'imports']);
const IMPORT_KEYS = new Set(['from', 'collections', 'access']);
const COLLECTION_KEYS = new Set([
  'kind',
  'visibility',
  'write',
  'counters',
  'marks',
  'indexes',
  'showAuthor',
  'ttlSeconds',
  'maxEntries',
  'dailyWritesPerAuthor',
  'ownedModelVersions',
  'exportable',
  'schema',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A key as it appears in an error, bounded so a huge key cannot bloat the message. */
function boundKey(key: string): string {
  return key.length > 80 ? `${key.slice(0, 80)}…` : key;
}

function quoteName(name: string): string {
  return JSON.stringify(boundKey(name));
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** `subject` is the field, plus its value when the value is what is gated. */
function notYet(subject: string, feature: string, instead: string): string {
  return `${subject} is not available yet — ${feature} arrive in a later phase of App Storage; ${instead}`;
}

/** Parses `counters` or `marks`. Returns the names, or null when the list is unusable. */
function parseTallyNames(
  at: string,
  raw: unknown,
  max: number,
  kind: 'counter' | 'mark',
  errors: string[]
): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${at} must be an array of names`);
    return null;
  }
  if (raw.length > max) {
    errors.push(`${at} may declare at most ${max} ${kind}s (found ${raw.length})`);
    return null;
  }
  const seen: string[] = [];
  for (const [index, name] of raw.entries()) {
    if (typeof name !== 'string' || !APP_STORAGE_TALLY_NAME_RE.test(name)) {
      errors.push(
        `${at}[${index}] must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _`
      );
      return null;
    }
    if (APP_STORAGE_BUILTIN_MARKS.includes(name)) {
      errors.push(
        kind === 'mark'
          ? `${at}[${index}] "${name}" is a built-in mark on every shared collection — do not declare it`
          : `${at}[${index}] "${name}" is the name of a built-in mark — choose another counter name`
      );
      return null;
    }
    if (seen.includes(name)) {
      errors.push(`${at}[${index}] duplicates an earlier ${kind} (${quoteName(name)})`);
      return null;
    }
    seen.push(name);
  }
  return seen;
}

function parseIndexes(
  at: string,
  raw: unknown,
  errors: string[]
): Map<string, AppStorageIndexType> | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be an object mapping a field path to its type`);
    return null;
  }
  const paths = Object.keys(raw);
  if (paths.length > APP_STORAGE_MAX_INDEXES) {
    errors.push(
      `${at} may declare at most ${APP_STORAGE_MAX_INDEXES} indexes (found ${paths.length})`
    );
    return null;
  }
  const indexes = new Map<string, AppStorageIndexType>();
  for (const path of paths) {
    if (!APP_STORAGE_INDEX_PATH_RE.test(path)) {
      errors.push(
        `${at} key ${quoteName(
          path
        )} must be a field path of 1 to ${APP_STORAGE_INDEX_MAX_DEPTH} segments joined by ".", each a letter then up to 31 letters, digits or _`
      );
      continue;
    }
    if (APP_STORAGE_RESERVED_INDEX_NAMES.includes(path)) {
      errors.push(
        `${at} key ${quoteName(
          path
        )} is a built-in sort key (${APP_STORAGE_RESERVED_INDEX_NAMES.join(
          ', '
        )}) and cannot be an index`
      );
      continue;
    }
    const type = raw[path];
    if (
      typeof type !== 'string' ||
      !(APP_STORAGE_INDEX_TYPES as readonly string[]).includes(type)
    ) {
      errors.push(`${at}.${path} must be one of ${APP_STORAGE_INDEX_TYPES.join(', ')}`);
      continue;
    }
    indexes.set(path, type as AppStorageIndexType);
  }
  return indexes;
}

function parseCollection(
  at: string,
  raw: unknown,
  features: Readonly<Record<AppStorageFeature, boolean>>,
  errors: string[]
): DeclaredStorageCollection | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const before = errors.length;
  for (const key of Object.keys(raw)) {
    if (!COLLECTION_KEYS.has(key)) errors.push(`${at}.${boundKey(key)} is not allowed`);
  }

  const { visibility } = raw;
  if (
    typeof visibility !== 'string' ||
    !(APP_STORAGE_VISIBILITIES as readonly string[]).includes(visibility)
  ) {
    errors.push(`${at}.visibility is required and must be one of private, shared`);
    // Every other rule depends on the visibility, so nothing more can be said usefully.
    return null;
  }
  const vis = visibility as AppStorageVisibility;
  const shared = vis === 'shared';

  let kind: AppStorageKind = 'docs';
  if (raw.kind !== undefined) {
    if (
      typeof raw.kind !== 'string' ||
      !(APP_STORAGE_KINDS as readonly string[]).includes(raw.kind)
    ) {
      errors.push(`${at}.kind must be one of ${APP_STORAGE_KINDS.join(', ')}`);
    } else {
      kind = raw.kind as AppStorageKind;
      if (kind === 'log' && !features.logCollections) {
        errors.push(
          notYet(
            `${at}.kind "log"`,
            'append-only log collections',
            'declare kind "docs" (or omit kind) for now'
          )
        );
      }
    }
  }

  let write: AppStorageWritePolicy | undefined;
  if (!shared) {
    if (raw.write !== undefined) {
      errors.push(
        `${at}.write applies only to shared collections — a private collection is written only by its viewer`
      );
    }
  } else if (raw.write === undefined) {
    errors.push(
      `${at}.write is required on a shared collection and must be one of ${APP_STORAGE_WRITE_POLICIES.join(
        ', '
      )}`
    );
  } else if (
    typeof raw.write !== 'string' ||
    !(APP_STORAGE_WRITE_POLICIES as readonly string[]).includes(raw.write)
  ) {
    errors.push(`${at}.write must be one of ${APP_STORAGE_WRITE_POLICIES.join(', ')}`);
  } else {
    write = raw.write as AppStorageWritePolicy;
    if (write === 'anyone' && !features.anyoneWrites) {
      errors.push(
        notYet(
          `${at}.write "anyone"`,
          'documents any viewer may edit',
          'use "own" or "none" for now'
        )
      );
    }
    if (write === 'owner' && !features.ownerWrites) {
      errors.push(
        notYet(`${at}.write "owner"`, 'owner-written documents', 'use "own" or "none" for now')
      );
    }
  }

  const sharedOnly = (field: string) =>
    errors.push(`${at}.${field} applies only to shared collections`);

  // Counters are SHARED-ONLY by decision, not by necessity: a counter is a tally on a
  // document that many viewers increment, and on a private collection only one viewer can
  // ever touch the document, so a counter there is a plain field of `data`. Refusing it
  // keeps one name from meaning two things; relaxing it later breaks no manifest.
  const beforeTallies = errors.length;
  let counters: string[] = [];
  if (raw.counters !== undefined) {
    if (!shared) sharedOnly('counters');
    else
      counters =
        parseTallyNames(
          `${at}.counters`,
          raw.counters,
          APP_STORAGE_MAX_COUNTERS,
          'counter',
          errors
        ) ?? [];
  }
  let marks: string[] = [];
  if (raw.marks !== undefined) {
    if (!shared) sharedOnly('marks');
    else
      marks =
        parseTallyNames(`${at}.marks`, raw.marks, APP_STORAGE_MAX_MARKS, 'mark', errors) ?? [];
  }
  // CROSS-FIELD: a `write: "none"` collection is written ONLY through its counters and
  // marks, so with neither it could never hold anything. Skipped when the tally lists are
  // themselves invalid, which already has its own error.
  if (
    write === 'none' &&
    counters.length === 0 &&
    marks.length === 0 &&
    errors.length === beforeTallies
  ) {
    errors.push(
      `${at} has write "none" but declares no counters or marks, so nothing could ever be written to it — declare at least one counter or mark, or choose another write policy`
    );
  }
  // CROSS-FIELD: one name may not be both a counter and a mark. The two are separate
  // tallies, and `sort=counter:<n>` / `sort=mark:<n>` would then name two different
  // numbers by one word in the review table and in the app's own code.
  for (const name of counters) {
    if (marks.includes(name)) {
      errors.push(
        `${at} declares ${quoteName(name)} as both a counter and a mark — use different names`
      );
    }
  }

  let indexes = new Map<string, AppStorageIndexType>();
  if (raw.indexes !== undefined) {
    indexes = parseIndexes(`${at}.indexes`, raw.indexes, errors) ?? indexes;
  }

  let showAuthor = false;
  if (raw.showAuthor !== undefined) {
    if (!shared) sharedOnly('showAuthor');
    else if (typeof raw.showAuthor !== 'boolean') errors.push(`${at}.showAuthor must be a boolean`);
    else showAuthor = raw.showAuthor;
  }

  if (raw.ttlSeconds !== undefined) {
    if (!isIntegerIn(raw.ttlSeconds, APP_STORAGE_TTL_MIN_SECONDS, APP_STORAGE_TTL_MAX_SECONDS)) {
      errors.push(
        `${at}.ttlSeconds must be a whole number of seconds from ${APP_STORAGE_TTL_MIN_SECONDS} to ${APP_STORAGE_TTL_MAX_SECONDS}`
      );
    } else if (!features.ttl) {
      errors.push(notYet(`${at}.ttlSeconds`, 'expiring documents', 'remove ttlSeconds for now'));
    }
  }

  if (raw.maxEntries !== undefined) {
    if (kind !== 'log') {
      errors.push(`${at}.maxEntries applies only to kind "log"`);
    } else if (!isIntegerIn(raw.maxEntries, 1, APP_STORAGE_LOG_MAX_ENTRIES)) {
      errors.push(
        `${at}.maxEntries must be a whole number from 1 to ${APP_STORAGE_LOG_MAX_ENTRIES}`
      );
    }
  }

  if (raw.dailyWritesPerAuthor !== undefined) {
    if (!shared) {
      sharedOnly('dailyWritesPerAuthor');
    } else if (write === 'owner') {
      errors.push(
        `${at}.dailyWritesPerAuthor does not apply to write "owner" — only the app owner writes that collection`
      );
    } else if (write === 'none') {
      errors.push(
        `${at}.dailyWritesPerAuthor does not apply to write "none" — viewers do not create or edit documents in that collection`
      );
    } else if (!isIntegerIn(raw.dailyWritesPerAuthor, 1, APP_STORAGE_MAX_DAILY_WRITES_PER_AUTHOR)) {
      errors.push(
        `${at}.dailyWritesPerAuthor must be a whole number from 1 to ${APP_STORAGE_MAX_DAILY_WRITES_PER_AUTHOR}`
      );
    } else if (!features.perAuthorWriteBudget) {
      errors.push(
        notYet(
          `${at}.dailyWritesPerAuthor`,
          'per-collection write budgets',
          'remove dailyWritesPerAuthor for now (the platform default applies)'
        )
      );
    }
  }

  let ownedModelVersions: string[] | null = null;
  if (raw.ownedModelVersions !== undefined) {
    if (!shared) {
      sharedOnly('ownedModelVersions');
    } else if (
      !(write === undefined || APP_STORAGE_OWNED_MODEL_VERSIONS_WRITE_POLICIES.includes(write))
    ) {
      errors.push(
        `${at}.ownedModelVersions applies only to shared collections with write "own" — the viewer writing a document must be its author`
      );
    } else {
      ownedModelVersions = parseOwnedPointers(
        `${at}.ownedModelVersions`,
        raw.ownedModelVersions,
        errors
      );
    }
  }

  if (raw.exportable !== undefined && typeof raw.exportable !== 'boolean') {
    errors.push(`${at}.exportable must be a boolean`);
  }

  let schema: AppStorageCollectionSchema | null = null;
  if (raw.schema !== undefined) {
    if (write === 'none') {
      errors.push(
        `${at}.schema does not apply to write "none" — no document body is ever written to that collection, so a schema would check nothing`
      );
    } else {
      schema = parseCollectionSchema(`${at}.schema`, raw.schema, errors);
    }
  }

  if (errors.length > before) return null;
  const collection: DeclaredStorageCollection = {
    kind,
    visibility: vis,
    counters,
    marks,
    indexes,
    showAuthor,
  };
  if (write !== undefined) collection.write = write;
  if (raw.ttlSeconds !== undefined) collection.ttlSeconds = raw.ttlSeconds as number;
  if (raw.maxEntries !== undefined) collection.maxEntries = raw.maxEntries as number;
  if (raw.dailyWritesPerAuthor !== undefined)
    collection.dailyWritesPerAuthor = raw.dailyWritesPerAuthor as number;
  if (ownedModelVersions) collection.ownedModelVersions = ownedModelVersions;
  if (raw.exportable !== undefined) collection.exportable = raw.exportable as boolean;
  if (schema) collection.schema = schema;
  return collection;
}

function parseOwnedPointers(at: string, raw: unknown, errors: string[]): string[] | null {
  if (!Array.isArray(raw)) {
    errors.push(`${at} must be an array of pointers`);
    return null;
  }
  // An empty list would read as a declared ownership rule that checks nothing.
  if (raw.length === 0 || raw.length > APP_STORAGE_MAX_OWNED_MODEL_VERSIONS) {
    errors.push(
      `${at} must declare 1 to ${APP_STORAGE_MAX_OWNED_MODEL_VERSIONS} pointers (found ${raw.length})`
    );
    return null;
  }
  const seen: string[] = [];
  for (const [index, pointer] of raw.entries()) {
    if (typeof pointer !== 'string' || !APP_STORAGE_OWNED_POINTER_RE.test(pointer)) {
      errors.push(
        `${at}[${index}] must be a pointer into the document's data, such as "/workflow/modelVersionId": 1 to 4 segments, each "/" then a letter or _ followed by up to 63 letters, digits or _`
      );
      return null;
    }
    if (seen.includes(pointer)) {
      errors.push(`${at}[${index}] duplicates an earlier pointer (${quoteName(pointer)})`);
      return null;
    }
    seen.push(pointer);
  }
  return seen;
}

function parseImports(
  raw: unknown,
  ownBlockId: unknown,
  errors: string[]
): Map<string, DeclaredStorageImport> {
  const imports = new Map<string, DeclaredStorageImport>();
  if (!Array.isArray(raw)) {
    errors.push('storage.imports must be an array of { from, collections, access }');
    return imports;
  }
  if (raw.length === 0) {
    errors.push('storage.imports must declare at least one import (or omit it)');
    return imports;
  }
  if (raw.length > APP_STORAGE_MAX_IMPORTS) {
    errors.push(
      `storage.imports may declare at most ${APP_STORAGE_MAX_IMPORTS} imports (found ${raw.length})`
    );
    return imports;
  }
  for (const [index, entry] of raw.entries()) {
    const at = `storage.imports[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${at} must be an object`);
      continue;
    }
    const before = errors.length;
    for (const key of Object.keys(entry)) {
      if (!IMPORT_KEYS.has(key)) errors.push(`${at}.${boundKey(key)} is not allowed`);
    }
    const { from, access } = entry;
    if (typeof from !== 'string' || !APP_STORAGE_IMPORT_FROM_RE.test(from)) {
      errors.push(
        `${at}.from must be the source app's blockId: 3 to 40 of a-z, 0-9 or -, starting with a letter`
      );
    } else if (from === ownBlockId) {
      errors.push(`${at}.from names this app itself — declare its collections instead`);
    } else if (imports.has(from)) {
      errors.push(`${at} imports from ${quoteName(from)} again — declare one import per app`);
    }
    if (
      typeof access !== 'string' ||
      !(APP_STORAGE_IMPORT_ACCESS as readonly string[]).includes(access)
    ) {
      errors.push(
        `${at}.access is required and must be one of ${APP_STORAGE_IMPORT_ACCESS.join(', ')}`
      );
    }
    const names = entry.collections;
    const seen = new Set<string>();
    if (!Array.isArray(names) || names.length === 0) {
      errors.push(`${at}.collections must be a non-empty array of collection names`);
    } else if (names.length > APP_STORAGE_MAX_IMPORT_COLLECTIONS) {
      errors.push(
        `${at}.collections may name at most ${APP_STORAGE_MAX_IMPORT_COLLECTIONS} collections (found ${names.length})`
      );
    } else {
      for (const [i, name] of names.entries()) {
        if (typeof name !== 'string' || !APP_STORAGE_COLLECTION_NAME_RE.test(name)) {
          errors.push(
            `${at}.collections[${i}] must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _`
          );
        } else if (seen.has(name)) {
          errors.push(
            `${at}.collections[${i}] duplicates an earlier collection (${quoteName(name)})`
          );
        } else {
          seen.add(name);
        }
      }
    }
    if (errors.length > before) continue;
    imports.set(from as string, {
      from: from as string,
      collections: seen,
      access: access as AppStorageImportAccess,
    });
  }
  return imports;
}

const SCHEMA_KEYWORDS = new Set<string>(APP_STORAGE_SCHEMA_KEYWORDS);
const SCHEMA_TYPES = new Set<string>(APP_STORAGE_SCHEMA_TYPES);
const SCHEMA_COUNT_KEYWORDS = ['minLength', 'maxLength', 'minItems', 'maxItems'] as const;
const SCHEMA_BOUND_PAIRS = [
  ['minLength', 'maxLength'],
  ['minItems', 'maxItems'],
  ['minimum', 'maximum'],
] as const;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Parses one collection's `schema` (see {@link APP_STORAGE_SCHEMA_KEYWORDS}). Returns the
 * schema as declared, or null after pushing one error per problem found. The size is checked
 * first, so the walk below only ever sees at most {@link APP_STORAGE_SCHEMA_MAX_BYTES}; the
 * walk stops descending at the depth limit, so its recursion is bounded too.
 */
export function parseCollectionSchema(
  at: string,
  raw: unknown,
  errors: string[]
): AppStorageCollectionSchema | null {
  if (!isPlainObject(raw)) {
    errors.push(`${at} must be a schema object`);
    return null;
  }
  const bytes = utf8Bytes(JSON.stringify(raw));
  if (bytes > APP_STORAGE_SCHEMA_MAX_BYTES) {
    errors.push(
      `${at} is ${bytes} bytes of JSON — a collection schema may be at most ${APP_STORAGE_SCHEMA_MAX_BYTES} bytes`
    );
    return null;
  }
  const before = errors.length;
  const state = { patterns: 0 };
  parseSchemaNode(at, raw, 1, errors, state);
  if (state.patterns > APP_STORAGE_SCHEMA_MAX_PATTERNS) {
    errors.push(
      `${at} declares ${state.patterns} patterns — a collection schema may declare at most ${APP_STORAGE_SCHEMA_MAX_PATTERNS}`
    );
  }
  return errors.length > before ? null : raw;
}

function parseSchemaNode(
  at: string,
  node: unknown,
  depth: number,
  errors: string[],
  state: { patterns: number }
): void {
  if (depth > APP_STORAGE_SCHEMA_MAX_DEPTH) {
    errors.push(
      `${at} is nested too deeply — a collection schema may nest at most ${APP_STORAGE_SCHEMA_MAX_DEPTH} schemas`
    );
    return;
  }
  if (!isPlainObject(node)) {
    errors.push(`${at} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      errors.push(
        `${at} uses the schema keyword ${quoteName(
          key
        )}, which is not supported — the supported keywords are ${APP_STORAGE_SCHEMA_KEYWORDS.join(
          ', '
        )}`
      );
    }
  }
  const child = (path: string, sub: unknown) =>
    parseSchemaNode(path, sub, depth + 1, errors, state);

  if (node.type !== undefined) {
    const list = Array.isArray(node.type) ? node.type : [node.type];
    const valid =
      list.length > 0 &&
      list.every((t) => typeof t === 'string' && SCHEMA_TYPES.has(t)) &&
      new Set(list).size === list.length;
    if (!valid) {
      errors.push(
        `${at}.type must be one of ${APP_STORAGE_SCHEMA_TYPES.join(
          ', '
        )}, or a non-empty array of them without repeats`
      );
    }
  }
  if (node.properties !== undefined) {
    if (!isPlainObject(node.properties)) {
      errors.push(`${at}.properties must be an object mapping a property name to its schema`);
    } else {
      for (const [name, sub] of Object.entries(node.properties)) {
        child(`${at}.properties.${boundKey(name)}`, sub);
      }
    }
  }
  if (node.required !== undefined) {
    const list = node.required;
    if (
      !Array.isArray(list) ||
      !list.every((k) => typeof k === 'string') ||
      new Set(list).size !== list.length
    ) {
      errors.push(`${at}.required must be an array of distinct property names`);
    }
  }
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
    child(`${at}.additionalProperties`, node.additionalProperties);
  }
  if (node.items !== undefined) child(`${at}.items`, node.items);
  if (node.enum !== undefined && !(Array.isArray(node.enum) && node.enum.length > 0)) {
    errors.push(`${at}.enum must be a non-empty array of values`);
  }
  for (const keyword of SCHEMA_COUNT_KEYWORDS) {
    const value = node[keyword];
    if (value !== undefined && !isIntegerIn(value, 0, Number.MAX_SAFE_INTEGER)) {
      errors.push(`${at}.${keyword} must be a whole number of 0 or more`);
    }
  }
  for (const keyword of ['minimum', 'maximum'] as const) {
    const value = node[keyword];
    if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) {
      errors.push(`${at}.${keyword} must be a number`);
    }
  }
  for (const [low, high] of SCHEMA_BOUND_PAIRS) {
    const a = node[low];
    const b = node[high];
    if (typeof a === 'number' && typeof b === 'number' && a > b) {
      errors.push(`${at}.${low} (${a}) is greater than ${high} (${b}), so nothing could match`);
    }
  }
  if (node.pattern !== undefined) {
    state.patterns++;
    const pattern = node.pattern;
    if (
      typeof pattern !== 'string' ||
      Array.from(pattern).length > APP_STORAGE_SCHEMA_PATTERN_MAX_LENGTH
    ) {
      errors.push(
        `${at}.pattern must be a string of at most ${APP_STORAGE_SCHEMA_PATTERN_MAX_LENGTH} characters`
      );
    } else {
      try {
        new RegExp(pattern, APP_STORAGE_SCHEMA_PATTERN_FLAGS);
      } catch {
        errors.push(
          `${at}.pattern is not a valid regular expression (JavaScript syntax with the "u" flag)`
        );
      }
    }
    if (
      !isIntegerIn(node.maxLength, 0, APP_STORAGE_SCHEMA_PATTERNED_MAX_LENGTH) &&
      // A malformed maxLength already has its own error.
      (node.maxLength === undefined || isIntegerIn(node.maxLength, 0, Number.MAX_SAFE_INTEGER))
    ) {
      errors.push(
        `${at}.pattern needs a maxLength of at most ${APP_STORAGE_SCHEMA_PATTERNED_MAX_LENGTH} on the same schema — a pattern only ever runs against a bounded string`
      );
    }
  }
  if (node.description !== undefined && typeof node.description !== 'string') {
    errors.push(`${at}.description must be a string`);
  }
}

/**
 * Every `pattern` in the declared collection schemas, with where it is and the flags it is
 * compiled with — for the submit-time ReDoS gate (`BlockManifestValidator.validateSubmission`),
 * which needs a server-only analyser. Empty when `storage` does not parse (its errors are
 * reported anyway), so a manifest over {@link APP_STORAGE_MANIFEST_MAX_PATTERNS} is never
 * analysed.
 */
export function collectionSchemaPatterns(
  parsed: ParsedManifestStorage
): { at: string; pattern: string; flags: string }[] {
  if (parsed.errors.length > 0) return [];
  return schemaPatternSites(parsed.collections).map(({ at, pattern }) => ({
    at,
    pattern,
    flags: APP_STORAGE_SCHEMA_PATTERN_FLAGS,
  }));
}

/** Every `pattern` in the collections' schemas, in declaration order, with where it is. */
function schemaPatternSites(
  collections: ReadonlyMap<string, DeclaredStorageCollection>
): { at: string; pattern: string }[] {
  const out: { at: string; pattern: string }[] = [];
  const walk = (at: string, node: unknown) => {
    if (!isPlainObject(node)) return;
    if (typeof node.pattern === 'string') out.push({ at: `${at}.pattern`, pattern: node.pattern });
    if (isPlainObject(node.properties)) {
      for (const [name, sub] of Object.entries(node.properties)) {
        walk(`${at}.properties.${boundKey(name)}`, sub);
      }
    }
    walk(`${at}.items`, node.items);
    walk(`${at}.additionalProperties`, node.additionalProperties);
  };
  for (const [name, collection] of collections) {
    if (collection.schema) walk(`storage.collections.${name}.schema`, collection.schema);
  }
  return out;
}

function parse(
  manifest: unknown,
  features: Readonly<Record<AppStorageFeature, boolean>>
): ParsedManifestStorage {
  const collections = new Map<string, DeclaredStorageCollection>();
  const noImports = new Map<string, DeclaredStorageImport>();
  if (!isPlainObject(manifest) || manifest.storage === undefined) {
    return { declared: false, collections, imports: noImports, errors: [] };
  }
  const storage = manifest.storage;
  if (!isPlainObject(storage)) {
    return {
      declared: true,
      collections,
      imports: noImports,
      errors: ['storage must be an object'],
    };
  }
  const errors: string[] = [];
  for (const key of Object.keys(storage)) {
    if (!STORAGE_KEYS.has(key)) {
      errors.push(
        `storage.${boundKey(key)} is not allowed (storage takes only collections and imports)`
      );
    }
  }
  const imports =
    storage.imports === undefined
      ? noImports
      : parseImports(storage.imports, manifest.blockId, errors);
  const done = (): ParsedManifestStorage => ({ declared: true, collections, imports, errors });
  const raw = storage.collections;
  // An app that only reads other apps' data declares no collections of its own.
  if (raw === undefined && storage.imports !== undefined) return done();
  if (!isPlainObject(raw)) {
    errors.push('storage.collections must be an object mapping collection name to declaration');
    return done();
  }
  const names = Object.keys(raw);
  if (names.length === 0) {
    errors.push('storage.collections must declare at least one collection (or omit storage)');
    return done();
  }
  if (names.length > APP_STORAGE_MAX_COLLECTIONS) {
    errors.push(
      `storage.collections may declare at most ${APP_STORAGE_MAX_COLLECTIONS} collections (found ${names.length})`
    );
    return done();
  }
  for (const name of names) {
    if (!APP_STORAGE_COLLECTION_NAME_RE.test(name)) {
      errors.push(
        `storage.collections key ${quoteName(
          name
        )} must be lowercase snake_case: a letter, then up to 31 of a-z, 0-9 or _`
      );
      continue;
    }
    const collection = parseCollection(`storage.collections.${name}`, raw[name], features, errors);
    if (collection) collections.set(name, collection);
  }
  // Counted over the collections that parsed: one over its own cap is already refused.
  const patterns = schemaPatternSites(collections).length;
  if (patterns > APP_STORAGE_MANIFEST_MAX_PATTERNS) {
    errors.push(
      `storage.collections declare ${patterns} patterns across their schemas — a manifest may declare at most ${APP_STORAGE_MANIFEST_MAX_PATTERNS} in all`
    );
  }
  return done();
}

/**
 * THE `storage` parser. The submit-time manifest validator reads its `errors`; a consumer
 * that needs the declaration (the storage routes, the review table) reads `collections`.
 *
 * - **Total.** Never throws. A manifest with no `storage` key is valid and declares nothing.
 * - **All or nothing.** If there is ANY error, `collections` and `imports` are empty.
 * - **Bounded errors.** At most {@link APP_STORAGE_MAX_ERRORS} messages plus one summary.
 * - **Phase-gated.** Features switched off in `features` (default
 *   {@link APP_STORAGE_ENABLED_FEATURES}) are refused even though the schema admits them.
 *   The parameter exists so a test can show a refusal is the gate's and not a shape error;
 *   production callers never pass it.
 */
export function parseManifestStorage(
  manifest: unknown,
  features: Readonly<Record<AppStorageFeature, boolean>> = APP_STORAGE_ENABLED_FEATURES
): ParsedManifestStorage {
  return boundedManifestParse<ParsedManifestStorage>({
    noun: 'storage',
    maxErrors: APP_STORAGE_MAX_ERRORS,
    parse: () => parse(manifest, features),
    // A throw can only come from reading a present `storage` value, so it was declared.
    invalid: (errors, parsed) => ({
      declared: parsed?.declared ?? true,
      collections: new Map(),
      imports: new Map(),
      errors,
    }),
  });
}

/** Does this declared collection let viewers write documents other viewers read? */
export function collectionNeedsPublishScope(collection: DeclaredStorageCollection): boolean {
  // An allowlist of the policies under which a VIEWER authors documents, not "anything but
  // owner": a new policy must be classified here deliberately, and `none` (counters and
  // marks only) must never require the consent-gated publish scope. `anyone` stays listed
  // although the feature switch refuses it today, so enabling it needs no change here.
  return (
    collection.visibility === 'shared' &&
    collection.write !== undefined &&
    (VIEWER_AUTHORED_WRITE_POLICIES as readonly string[]).includes(collection.write)
  );
}

/** The write policies under which a viewer authors documents other viewers read. */
const VIEWER_AUTHORED_WRITE_POLICIES = [
  'own',
  'anyone',
] as const satisfies readonly AppStorageWritePolicy[];

/**
 * The viewer-authored policies an author can declare TODAY, for error text: `anyone` only
 * while its feature is switched on, so a message never suggests a value submit refuses.
 */
function availableViewerAuthoredPolicies(): string[] {
  return VIEWER_AUTHORED_WRITE_POLICIES.filter(
    (policy) => policy !== 'anyone' || APP_STORAGE_ENABLED_FEATURES.anyoneWrites
  ).map((policy) => `"${policy}"`);
}

/**
 * The CROSS-FIELD rules between `storage` and `scopes`. Returns no errors when `storage`
 * itself has errors: the author fixes the declaration first, and an invalid declaration
 * declares nothing, so a scope rule evaluated against it would report a second, misleading
 * problem.
 *
 * - Declaring any collection requires {@link APP_STORAGE_BASE_SCOPE}.
 * - Declaring a shared collection whose `write` is `own` or `anyone` requires
 *   {@link APP_STORAGE_PUBLISH_SCOPE}. `owner` and `none` do not: no viewer authors a
 *   document in them (marks and counters are `apps:storage`).
 * - Declaring any import requires {@link APP_STORAGE_IMPORT_SCOPE} (and the base scope:
 *   the storage route requires it on every call).
 * - REFUSED, not warned: requesting any of these scopes with nothing in `storage` for it to
 *   reach. The validator has no warning channel, and a permission that can reach nothing
 *   is over-asking at review and, for the consent-gated scopes, a prompt about nothing.
 */
export function appStorageScopeErrors(scopes: unknown, parsed: ParsedManifestStorage): string[] {
  if (parsed.errors.length > 0) return [];
  const declared = new Set(
    Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === 'string') : []
  );
  const errors: string[] = [];
  const names = [...parsed.collections.keys()];
  const sources = [...parsed.imports.keys()];
  const publishing = [...parsed.collections.entries()]
    .filter(([, c]) => collectionNeedsPublishScope(c))
    .map(([name]) => name);

  if (names.length === 0 && sources.length > 0 && !declared.has(APP_STORAGE_BASE_SCOPE)) {
    errors.push(
      `storage imports from ${sources.join(
        ', '
      )} but scopes does not include ${APP_STORAGE_BASE_SCOPE} — add it, or remove storage`
    );
  }
  if (sources.length > 0 && !declared.has(APP_STORAGE_IMPORT_SCOPE)) {
    errors.push(
      `storage imports from ${sources.join(
        ', '
      )}, which requires the ${APP_STORAGE_IMPORT_SCOPE} scope — add it to scopes with a scopeJustifications entry`
    );
  }
  if (sources.length === 0 && declared.has(APP_STORAGE_IMPORT_SCOPE)) {
    errors.push(
      `scopes includes ${APP_STORAGE_IMPORT_SCOPE} but storage declares no imports — declare them under storage.imports, or remove the scope`
    );
  }
  if (names.length > 0 && !declared.has(APP_STORAGE_BASE_SCOPE)) {
    errors.push(
      `storage declares ${names.join(
        ', '
      )} but scopes does not include ${APP_STORAGE_BASE_SCOPE} — add it, or remove storage`
    );
  }
  if (publishing.length > 0 && !declared.has(APP_STORAGE_PUBLISH_SCOPE)) {
    errors.push(
      `storage collection ${publishing.join(
        ', '
      )} lets viewers write documents other users read, which requires the ${APP_STORAGE_PUBLISH_SCOPE} scope — add it to scopes with a scopeJustifications entry`
    );
  }
  if (names.length === 0 && sources.length === 0 && declared.has(APP_STORAGE_BASE_SCOPE)) {
    errors.push(
      `scopes includes ${APP_STORAGE_BASE_SCOPE} but storage declares no collections — declare them under storage.collections, or remove the scope`
    );
  }
  if (publishing.length === 0 && declared.has(APP_STORAGE_PUBLISH_SCOPE)) {
    errors.push(
      `scopes includes ${APP_STORAGE_PUBLISH_SCOPE} but no storage collection is shared with write ${availableViewerAuthoredPolicies().join(
        ' or '
      )} — remove the scope, or declare the collection it is for`
    );
  }
  return errors;
}
