// Types, limits and the error class for the App Blocks document store
// (`./doc-store.ts`). No SQL lives here; `doc-store.ts` is the only module that
// touches the `appdata` tables.
import { logToAxiom } from '~/server/logging/client';
import type {
  AppStorageIndexType,
  DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';

/**
 * One collection's declaration — the manifest parser's own type, so the store sees exactly
 * what the validator accepted at review. The store never reads `showAuthor` or
 * `ownedModelVersions`; the REST layer applies them (`doc-store-api.ts`,
 * `doc-store-ownership.ts`). The store still refuses, itself, the parts the parser admits
 * only behind `APP_STORAGE_ENABLED_FEATURES` (`write: 'anyone'`, `kind: 'log'`,
 * `ttlSeconds`, `maxEntries`, `dailyWritesPerAuthor`); `write: 'owner'` is accepted and
 * means nobody writes documents until owner writes exist. The parser requires `write` on a
 * shared collection; the store reads an absent one as `own`.
 */
export type DocCollectionConfig = DeclaredStorageCollection;

export type DocIndexType = AppStorageIndexType;

/**
 * A collection as the store sees it: its declared name plus its declaration.
 *
 * `schemaMajor` is the collection's current schema major (`storage-schema-majors.ts`), which a
 * write of a document body stamps into the document row's `schema_major` column (once that manual migration is
 * applied). Absent: the write leaves the column alone (development and review namespaces, which
 * are never stamped). `null`: the major is not known, and the write clears any older stamp, since
 * the body it held no longer describes the document. The column is read only by a read path that
 * migrates a body on serve (a caller of `applyMajorChain`); any other read ignores it.
 */
export type DocCollection = {
  name: string;
  config: DocCollectionConfig;
  schemaMajor?: number | null;
};

/**
 * The resolved identity every operation runs under. Produced by the caller's
 * token resolver from verified claims — never from request input.
 *   - `appId`: the approved app's id.
 *   - `ns`: `prod`, `dev:<uid>` or `rev:<publishRequestId>:<moderatorUid>` (the app id of a
 *     review context is the publish request id, and its viewer is that moderator).
 *   - `viewerUid`: the signed-in viewer, or null for an anonymous viewer.
 *   - `levels`: present only while the app's `app-blocks-shared-doc-levels` flag is on
 *     (`doc-levels.ts`). Absent, every statement is the one the store ran before levels existed.
 */
export type DocStoreContext = {
  appId: string;
  ns: string;
  viewerUid: number | null;
  levels?: DocLevelGate;
};

/**
 * Content levels of shared documents, on (see `DocStoreContext.levels`). A shared write marks its
 * document `pending`; a read leaves out the documents whose status is unrated or `pending` (unless
 * the reader is their author), and rated ones whose effective level (`override_level` if set, else
 * `level`) has no bit in common with `viewerLevel` — or, for the reader's own documents, with
 * `domainLevel` (`sharedDocLevelVisible` in `doc-store.ts`).
 */
export type DocLevelGate = {
  /** The viewer's browsing level, a bitwise NsfwLevel flag set (`viewerDocLevel`). */
  viewerLevel: number;
  /**
   * The token's domain ceiling (`domainDocLevel`), which caps an author's own RATED documents.
   * Absent for a read with no viewer (the registry feed), where `viewerLevel` stands in.
   */
  domainLevel?: number;
};

export type DocRatingStatus = 'pending' | 'rated' | 'overridden';

/** A shared document's content level as a reader sees it. Set only while levels are on. */
export type DocRating = {
  /** The effective level: the moderator's override when set, else the rated level. */
  level: number | null;
  status: DocRatingStatus | null;
};

export type DocAuthor =
  /** `uid` is for the envelope layer to resolve a username from; it must never reach a reader. */
  | { kind: 'user'; uid: number; isViewer: boolean }
  | { kind: 'app' }
  /** Created by the first increment of a counter; nobody owns it. */
  | { kind: 'counter' };

export type DocRecord = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  author: DocAuthor;
  counters: Record<string, number>;
  marks: Record<string, number>;
  /** Null for an anonymous viewer. */
  viewer: { marks: string[] } | null;
  /** Server-set and read only; present only while levels are on (`DocStoreContext.levels`). */
  rating?: DocRating;
};

export type DocListQuery = {
  /** Equality on ONE declared index. */
  where?: Record<string, string | number | boolean>;
  /** `[-]key|createdAt|updatedAt|<index>|counter:<name>|mark:<name>`. Default `key`. */
  sort?: string;
  author?: 'me';
  markedBy?: 'me';
  mark?: string;
  keyPrefix?: string;
  limit?: number;
  cursor?: string;
};

export type DocListResult = { items: DocRecord[]; nextCursor: string | null };

/**
 * Stored usage for (app, ns), and for the viewer within it (null for an anonymous viewer).
 * `app` is the app's SHARED documents only — what the app ceiling (`appBytes` / `appDocs`)
 * measures. `viewer` is everything charged to the viewer: their private documents, the shared
 * documents they authored and the counter documents their increment created — what the
 * per-viewer ceiling (`userBytes` / `userDocs`) measures. So `viewer` can exceed `app`.
 */
export type DocStoreUsage = {
  app: { bytes: number; docs: number };
  viewer: { bytes: number; docs: number } | null;
};

export type DocStoreLimits = {
  appBytes: number;
  appDocs: number;
  userBytes: number;
  userDocs: number;
};

/**
 * Per-(app, namespace) and per-(app, namespace, user) ceilings, in the stored unit. The app
 * ceiling counts SHARED documents only; a private document counts toward its viewer's ceiling
 * alone (see WHICH CEILINGS in `doc-store.ts`).
 */
export const DEFAULT_DOC_STORE_LIMITS: DocStoreLimits = {
  appBytes: 50 * 1024 * 1024,
  appDocs: 1_000_000,
  userBytes: 2 * 1024 * 1024,
  userDocs: 1_000,
};

export const DOC_STORE_BOUNDS = {
  collectionName: /^[a-z][a-z0-9_]{0,31}$/,
  /**
   * 1–128 chars of `[A-Za-z0-9._:-]` — ASCII only, so 128 chars is 128 bytes. A key made only
   * of dots is additionally refused (`doc-store.ts`): URL clients rewrite `.` and `..` segments.
   */
  key: /^[A-Za-z0-9._:-]{1,128}$/,
  /** Stored unit (`octet_length(data::text)`); also a CHECK constraint on the doc table. */
  docBytes: 65536,
  depth: 16,
  stringIndexBytes: 128,
  indexPathSegments: 3,
  indexesPerCollection: 4,
  equalityFilters: 1,
  listLimitMax: 100,
  listLimitDefault: 25,
  getManyMax: 100,
  cursorChars: 512,
  incrementMax: 100,
} as const;

export const REPORT_MARK = 'report';

/** Stable codes from the storage proposal's error table. The HTTP mapping belongs to the route layer. */
export type DocStoreErrorCode =
  | 'invalid_request'
  | 'index_not_declared'
  | 'unauthenticated'
  | 'sign_in_required'
  | 'insufficient_scope'
  | 'consent_required'
  /** A collection call named another app (`from`) that the caller's manifest does not import. */
  | 'import_not_declared'
  /** The source app's collection is declared `exportable: false`. */
  | 'not_exportable'
  | 'not_eligible'
  | 'not_author'
  | 'write_policy'
  | 'resource_not_owned'
  /** A document body does not match its collection's declared `schema` (`doc-store-schema.ts`). */
  | 'schema_violation'
  | 'not_found'
  | 'collection_not_declared'
  | 'version_conflict'
  | 'index_building'
  | 'cursor_expired'
  | 'too_large'
  | 'quota_exceeded'
  | 'content_rejected'
  | 'rate_limited'
  | 'storage_disabled'
  | 'moderation_unavailable'
  /** The viewer's consent state could not be read; retryable (raised by the route layer). */
  | 'consent_unavailable'
  /**
   * Retryable: a dependency of the token check could not be read (raised by the route layer), or
   * the store's database could not be reached or dropped the connection (raised by the store).
   */
  | 'service_unavailable';

export type QuotaCeiling = 'app' | 'viewer' | 'author';

/** What `DocStoreMaintenance.wipeAccount` did in one (app, namespace). */
export type AccountWipeNamespaceResult = {
  appId: string;
  ns: string;
  /**
   * `namespace`: the namespace was the account's own dev namespace (`dev:<uid>`), so every row in
   * it was deleted. `user`: a namespace other users share (`prod`), so only what
   * names the account was deleted (or, for a counter document, released).
   */
  mode: 'namespace' | 'user';
  /** Private documents deleted (their index rows went with them). */
  privateDocs: number;
  /**
   * Bytes of those documents. They were charged to the account's own usage only, which the wipe
   * deletes; the app's usage never carried them, so nothing is refunded to it.
   */
  privateBytes: number;
  /** Shared documents the account authored, deleted as a moderator delete does. */
  sharedDocs: number;
  /** Bytes refunded to the app (and the account's own usage) for those documents. */
  sharedBytes: number;
  /** Counter-created documents whose creation was charged to the account: the uid dropped. */
  counterDocsReleased: number;
  /** The account's marks deleted, reports included; each one decremented its tally. */
  marks: number;
  /** Rows deleted in `namespace` mode, across every table (index rows not counted). */
  namespaceRows: number;
};

export type AccountWipeResult = {
  userId: number;
  namespaces: AccountWipeNamespaceResult[];
  /** Namespaces whose transaction failed and rolled back in full; a re-run retries them. */
  failures: { appId: string; ns: string; error: string }[];
  /** The caller's `proceed` said no before a namespace: the rest were not reached. */
  stopped: boolean;
};

/**
 * A maintenance operation that needs a hand-applied datastore migration ran before it was
 * applied (today: the app purge without `20261102120000_appdata_app_purge.sql`). Nothing was
 * deleted; every call refuses alike until the migration runs, so callers stop rather than retry
 * per item.
 */
export class DocStoreMigrationPendingError extends Error {
  readonly migration: string;

  constructor(migration: string, message: string) {
    super(message);
    this.name = 'DocStoreMigrationPendingError';
    this.migration = migration;
  }
}

export class DocStoreError extends Error {
  readonly code: DocStoreErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: DocStoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DocStoreError';
    this.code = code;
    this.details = details;
  }
}

export const docStoreUnavailable = () =>
  new DocStoreError('service_unavailable', 'storage is temporarily unavailable', {
    retryAfter: 1,
  });

/**
 * A read a storage gate depends on: a failure is retryable, never a refusal about the caller.
 * The client sees only the 503, so the original error is logged here or not at all.
 */
export async function docStoreDependency<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof DocStoreError) throw err;
    logToAxiom(
      {
        name: 'app-blocks-doc-store-dependency-fault',
        type: 'error',
        error: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      },
      'app-blocks'
    );
    throw docStoreUnavailable();
  }
}

export function isDocStoreError(err: unknown, code?: DocStoreErrorCode): err is DocStoreError {
  return err instanceof DocStoreError && (code === undefined || err.code === code);
}

// ---------------------------------------------------------------------------
// Server-side publish (`DocStore.publishCopies` / `unpublishCopies`)
// ---------------------------------------------------------------------------

/**
 * Bounds of one publish or unpublish call. `maxKeys` caps the keys a call names (more is refused
 * whole, `invalid_request` with `reason: 'too_many_keys'`); `pruneLimit` caps the copies one
 * publish prunes (the rest wait for the next call, `pruneIncomplete: true`).
 */
export const DOC_STORE_PUBLISH_BOUNDS = { maxKeys: 500, pruneLimit: 500 } as const;

/**
 * What a publish does with one requested key, decided from the caller's private document (the
 * source) and the shared document at the same key (the copy):
 * - `create`: no copy yet; `update`: the caller's own copy, with different content;
 * - `unchanged`: the caller's own copy with the same content: nothing is written;
 * - `missing`: the caller has no private document at that key;
 * - `not_author`: the copy belongs to someone else (or to no user): never touched;
 * - `hidden`: the caller's own copy, hidden by a moderator: never rewritten.
 */
export type PublishAction = 'create' | 'update' | 'unchanged' | 'missing' | 'not_author' | 'hidden';
export type PublishSkipReason = Extract<PublishAction, 'missing' | 'not_author' | 'hidden'>;

/** One requested key as a publish would treat it now (`DocStore.previewPublish`). */
export type PublishPreviewEntry = {
  key: string;
  action: PublishAction;
  /** The private body and its content hash; only for `create` and `update`. */
  source?: { data: Record<string, unknown>; hash: string };
};

/** Every list holds keys in key order. */
export type PublishResult = {
  created: string[];
  updated: string[];
  unchanged: string[];
  pruned: string[];
  skipped: { key: string; reason: PublishSkipReason }[];
  /** More copies were prunable than one call prunes: call again. */
  pruneIncomplete: boolean;
};

export type UnpublishResult = {
  deleted: string[];
  skipped: { key: string; reason: 'missing' | 'not_author' }[];
};
