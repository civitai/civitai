// Types, limits and the error class for the App Blocks document store
// (`./doc-store.ts`). No SQL lives here; `doc-store.ts` is the only module that
// touches the `appdata` tables.

/**
 * One collection's declaration: the shape of a manifest `storage.collections[name]`
 * entry. Defined here, in one place, until the manifest schema lands in its own
 * change; reconciling the two is a one-edit swap of this type for the schema's.
 */
export type DocCollectionConfig = {
  kind?: 'docs' | 'log';
  visibility: 'private' | 'shared';
  /**
   * Shared collections only. Defaults to `own`.
   *   own    — viewers create; only the author updates or deletes.
   *   anyone — viewers create, update and delete any document.
   *   owner  — only the app owner writes documents.
   *   none   — nobody writes documents; they exist only because a declared
   *            counter was incremented (which creates the document — under
   *            own, anyone and none; never under owner).
   * Counters and marks are not document writes and are allowed under all four.
   */
  write?: 'own' | 'anyone' | 'owner' | 'none';
  counters?: string[];
  /** Shared collections only. `report` is built in and need not be declared. */
  marks?: string[];
  /** Index name → type. The name is a dot path into `data`, at most 3 segments. */
  indexes?: Record<string, DocIndexType>;
  showAuthor?: boolean;
  ttlSeconds?: number;
  maxEntries?: number;
};

export type DocIndexType = 'string' | 'number' | 'boolean' | 'time';

/** A collection as the store sees it: its declared name plus its declaration. */
export type DocCollection = { name: string; config: DocCollectionConfig };

/**
 * The resolved identity every operation runs under. Produced by the caller's
 * token resolver from verified claims — never from request input.
 *   - `appId`: the approved app's id.
 *   - `ns`: `prod`, `dev:<uid>` or `rev:<publishRequestId>`.
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
  expiresAt: Date | null;
  author: DocAuthor;
  counters: Record<string, number>;
  marks: Record<string, number>;
  /** Null for an anonymous viewer. */
  viewer: { marks: string[] } | null;
};

export type DocRangeFilter = { gte?: string | number; lte?: string | number; prefix?: string };

export type DocListQuery = {
  /** Equality on up to two declared indexes, and/or a range on the sort index. */
  where?: Record<string, string | number | boolean | DocRangeFilter>;
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
  /** 1–128 chars of `[A-Za-z0-9._:-]` — ASCII only, so 128 chars is 128 bytes. */
  key: /^[A-Za-z0-9._:-]{1,128}$/,
  /** Stored unit (`octet_length(data::text)`); also a CHECK constraint on the doc table. */
  docBytes: 65536,
  depth: 16,
  stringIndexBytes: 128,
  indexPathSegments: 3,
  indexesPerCollection: 4,
  equalityFilters: 2,
  listLimitMax: 100,
  listLimitDefault: 25,
  getManyMax: 100,
  cursorChars: 512,
  incrementMax: 100,
  reportReasonChars: 500,
} as const;

export const REPORT_MARK = 'report';

/** Stable codes from the storage proposal's error table. The HTTP mapping belongs to the route layer. */
export type DocStoreErrorCode =
  | 'invalid_request'
  | 'index_not_declared'
  | 'unauthenticated'
  | 'sign_in_required'
  | 'scope_missing'
  | 'consent_required'
  | 'not_eligible'
  | 'not_author'
  | 'write_policy'
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
  | 'moderation_unavailable';

export type QuotaCeiling = 'app' | 'viewer' | 'author';

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

export function isDocStoreError(err: unknown, code?: DocStoreErrorCode): err is DocStoreError {
  return err instanceof DocStoreError && (code === undefined || err.code === code);
}
