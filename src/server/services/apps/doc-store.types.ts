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

/** A collection as the store sees it: its declared name plus its declaration. */
export type DocCollection = { name: string; config: DocCollectionConfig };

/**
 * The resolved identity every operation runs under. Produced by the caller's
 * token resolver from verified claims — never from request input.
 *   - `appId`: the approved app's id.
 *   - `ns`: `prod`, `dev:<uid>` or `rev:<publishRequestId>:<moderatorUid>` (the app id of a
 *     review context is the publish request id, and its viewer is that moderator).
 *   - `viewerUid`: the signed-in viewer, or null for an anonymous viewer.
 */
export type DocStoreContext = {
  appId: string;
  ns: string;
  viewerUid: number | null;
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

/** Stored usage for (app, ns), and for the viewer within it (null for an anonymous viewer). */
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

/** Per-(app, namespace) and per-(app, namespace, user) ceilings, in the stored unit. */
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
  | 'not_eligible'
  | 'not_author'
  | 'write_policy'
  | 'resource_not_owned'
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
  /** Bytes refunded to the app's usage for those documents. */
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
};

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
    ).catch(() => undefined);
    throw docStoreUnavailable();
  }
}

export function isDocStoreError(err: unknown, code?: DocStoreErrorCode): err is DocStoreError {
  return err instanceof DocStoreError && (code === undefined || err.code === code);
}
