// Types, limits and the error class for the App Blocks document store
// (`./doc-store.ts`). No SQL lives here; `doc-store.ts` is the only module that
// touches the `appdata` tables.
import { logToAxiom } from '~/server/logging/client';
import type {
  AppStorageIndexType,
  DeclaredStorageCollection,
} from '~/shared/constants/block-storage.constants';

/**
 * The five selectable content-level bits (PG 1, PG-13 2, R 4, X 8, XXX 16): the registry level
 * streams' bits, as a subscription's `meta.level` (`registry-adapter/level-feed.ts`) and as the
 * store's level-stream selector (`levelChanges`, `levelDocuments`). The one list of them.
 */
export const LEVEL_STREAM_BITS = [1, 2, 4, 8, 16] as const;

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
  { kind: 'user'; uid: number; isViewer: boolean } | { kind: 'app' };

export type DocRecord = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  author: DocAuthor;
  /** Server-set and read only; present only while levels are on (`DocStoreContext.levels`). */
  rating?: DocRating;
};

/**
 * What a document write (`create`, `put`, `putIfUnchanged`) answers: the record, plus where the
 * write sits in the app namespace's write order and which row it is. Internal to the store's API:
 * the public storage route presents a {@link DocRecord}'s fields only (`presentDocs`), never these.
 */
export type WrittenDocRecord = DocRecord & {
  /** The document's `seq` (`usage_app.last_seq` when it was written): the namespace's write order. */
  seq: number;
  /**
   * The row's `record_id` (the id in a private record's URN, `app-record.ts`). Null only for a row
   * written before the column's default existed and not yet backfilled.
   */
  recordId: string | null;
};

/**
 * What `delete` answers. `seq` is the tombstone's: the namespace's write order of the delete. A
 * delete that removed nothing wrote no tombstone and has none.
 */
export type DocDeleteResult = { deleted: true; seq: number } | { deleted: false };

export type DocListQuery = {
  /** Equality on ONE declared index. */
  where?: Record<string, string | number | boolean>;
  /** `[-]key|createdAt|updatedAt|<index>`. Default `key`. */
  sort?: string;
  author?: 'me';
  keyPrefix?: string;
  limit?: number;
  cursor?: string;
};

export type DocListResult = { items: DocRecord[]; nextCursor: string | null };

/**
 * Stored usage for (app, ns), and for the viewer within it (null for an anonymous viewer).
 * `app` is the app's SHARED documents only — what the app ceiling (`appBytes` / `appDocs`)
 * measures. `viewer` is everything charged to the viewer: their private documents and the shared
 * documents they authored — what the per-viewer ceiling (`userBytes` / `userDocs`) measures. So `viewer` can exceed `app`.
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
} as const;

/**
 * The one `doc_mark` name still written: a moderation report (the report API,
 * `doc-store-report-api.ts`). Marks, counters and their tallies were removed from the core
 * (docs/app-storage-generic-core.md, rollout step 5); `doc_mark` is the report store.
 */
export const REPORT_MARK = 'report';

/**
 * A viewer-keyed collection's PARENT key (`docs/app-storage-generic-core.md`, "Key derivation"):
 * the store's key grammar without `:`, at most 96 characters, not only dots. `:` is excluded so
 * `keyPrefix=<parent>:` lists exactly one parent's documents. The one definition: the `@me`
 * routes (`doc-store-viewer-keyed.ts`) and the mark migration's key check both apply it.
 */
export const VIEWER_KEY_PARENT_RE = /^[A-Za-z0-9._-]{1,96}$/;

/** Whether `parent` is a valid viewer-keyed parent key ({@link VIEWER_KEY_PARENT_RE}). */
export function isViewerKeyParent(parent: string): boolean {
  return VIEWER_KEY_PARENT_RE.test(parent) && !/^\.+$/.test(parent);
}

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
  /**
   * The operation no longer exists here (410). Raised by nothing since the mark, counter and
   * publish routes were removed (they now answer as unknown routes); kept so a client that
   * learned the code still reads it, and for a later removal that wants one.
   */
  | 'removed'
  | 'too_large'
  | 'quota_exceeded'
  | 'content_rejected'
  | 'rate_limited'
  /**
   * The collection's permission hook refused the write (`doc-store-hook.ts`). `details.cause` is
   * `denied` when the hook itself said no (the message is its reason), or the author-fault cause
   * (`error`, `timeout`, `oom`, `stack_overflow`, `invalid_result`) with a generic message.
   */
  | 'hook_rejected'
  /**
   * Retryable: the permission hook could not be evaluated (the runner is unreachable, timed out,
   * answered a non-2xx status or an unverifiable response, or is switched offline for the app).
   * The write is refused: a hooked collection never fails open.
   */
  | 'hook_unavailable'
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
   * names the account was deleted.
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
  /** The account's `doc_mark` rows deleted: its reports. */
  marks: number;
  /** Rows deleted in `namespace` mode, across every table (index rows not counted). */
  namespaceRows: number;
  /**
   * Maintenance runs (purge dumps and their results, mark-migration results) that named the
   * account and lost it (`user` mode; in `namespace` mode they are deleted with the rest).
   */
  maintRunsScrubbed: number;
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
// The unchanged-put rule (`classifyPublish` in `doc-store.ts`)
// ---------------------------------------------------------------------------

/**
 * What a write of a shared document's body would do, decided from the caller's body (the source)
 * and the stored shared document at the same key (the copy). Named for the server-side publish it
 * was built for (removed, docs/app-storage-generic-core.md rollout step 5); today only the free
 * unchanged put (`putIfUnchanged`) reads it:
 * - `create`: no stored document yet; `update`: the caller's own document, with different content;
 * - `unchanged`: the caller's own document with the same content: nothing is written;
 * - `missing`: no source body;
 * - `not_author`: the stored document belongs to someone else (or to no user);
 * - `hidden`: the caller's own document, hidden by a moderator.
 */
export type PublishAction = 'create' | 'update' | 'unchanged' | 'missing' | 'not_author' | 'hidden';
