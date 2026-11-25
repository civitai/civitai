// App Blocks document store — the data-access module over the `appdata` schema
// (migration: `./migrations/20261013120000_appdata_document_store.sql`).
//
// 🔴 THIS IS THE ONLY CODE THAT TOUCHES THE `appdata` TABLES. Every app's data
// lives in the same tables, so isolation is a predicate: every statement below
// takes `app_id = $1 AND ns = $2` from the resolved `DocStoreContext`, for every
// table it references, and `__tests__/doc-store.sql-isolation.test.ts` fails if
// one does not. Row-level security keyed on the transaction-local settings
// `appdata.app_id` / `appdata.ns` (set at the top of every transaction in
// `withTx`) is the second, independent layer.
//
// There are FOUR exceptions. The first is review maintenance (`purgeReview`, `listReviewAppIds`):
// statements keyed on `app_id = $1 AND ns LIKE 'rev:%'` (the listing: `ns LIKE 'rev:%'`
// on `usage_app` and `doc`), run only inside `maintenanceTx`, whose transaction-local
// `appdata.review_maintenance` setting is what the migration's review policies
// admit — review namespaces only, read and delete only.
//
// The second exception is the ACCOUNT WIPE's enumeration (`listAccountNamespaces`): one
// SELECT keyed on `user_id = $1` over `usage_user` and `doc_mark` (its reports), run only inside
// `accountWipeTx`, whose transaction-local `appdata.account_wipe_uid` setting the
// migration's wipe policy admits for that ONE user's rows of those two tables, read only.
// It returns (app, ns) pairs; the wipe of each runs in an ordinary `withTx`, keyed and
// scoped like any viewer call. The viewer-data listing (`listViewerUsage`) is a second SELECT
// of that shape, on `usage_user` alone, in the same transaction kind.
//
// The third is the APP PURGE's enumeration (`listAppNamespaces`): one SELECT keyed on
// `app_id = $1` with `ns > $2` (a keyset cursor) over `usage_app` and `doc`, run only inside
// `appPurgeTx`, whose transaction-local `appdata.app_purge_id` setting the app-purge migration's
// policy admits for that ONE app's rows of those two tables, read only. It returns namespaces;
// the purge of each runs in ordinary `withTx` transactions, like the account wipe.
//
// The fourth is the RATER LOOKUP (`findByRatingId`, content levels): one SELECT keyed on
// `rating_id = $1::int` over `doc`, returning one shared document's address only, run only inside
// `raterLookupTx`, whose transaction-local `appdata.rater_lookup_id` setting the rating-id
// migration's policy admits for that ONE row, read only. The rater then reads and rates the
// document in an ordinary `withTx`, keyed and scoped like any other call.
//
// Row-level security does not bind a superuser or BYPASSRLS role, so the store
// requires its own least-privilege connection (`APPDATA_DATABASE_URL`, see
// `doc-store.instance.ts`) and treats that as a CHECKED precondition: on first
// use it reads the connected role's attributes and refuses every call with
// `storage_disabled` if either is set (logged once). No pool at all is also
// `storage_disabled` — there is no fallback to any other connection.
//
// What this module does NOT do, by design — the caller (the REST layer) does it
// before calling in, and each is a seam at the call into an operation here:
//   - resolve the context (app id, namespace, viewer) from a verified token;
//   - the min-trust gate on viewer writes into shared collections (put, create,
//     delete) and on reports;
//   - rate limits;
//   - content moderation of shared writes;
//   - a collection's `ownedModelVersions` rule on create and put (`doc-store-ownership.ts`);
//   - call a collection's permission hook (`doc-store-hook.ts`). The store's part is to REFUSE a
//     viewer write to a hooked collection that does not carry a HookPass for exactly that write,
//     and to write only at the document version the pass carries (`requireHookPass`);
//   - map `DocStoreError` codes to HTTP statuses and envelopes;
//   - resolve `author.uid` to a username (and never forward the uid).
//
// A collection's declared `schema` it DOES check, on every document write (put and create):
// `doc-store-schema.ts`. Every write of a body also
// stamps the schema major the caller passes (`DocCollection.schemaMajor`) into
// `doc.schema_major`, once that manual-apply column exists (`stampWrittenDoc`). It is read only by
// a read path that migrates a body on serve (a caller of `applyMajorChain` in
// `storage-schema-majors.ts`, which takes the stamped major as `from`); any other read ignores it.
//
// Deliberately not supported yet, refused with `invalid_request` so a
// declaration that uses them fails loudly: `write: 'anyone'`, `ttlSeconds`,
// `kind: 'log'`, `maxEntries` and `dailyWritesPerAuthor`.
// The `expires_at` column and its index exist in the schema so TTL needs no
// second manual migration; nothing here reads or writes it.
//
// QUOTA IS RACE-FREE BY CONSTRUCTION. A write changes the `doc` row first, then
// charges the size delta with one conditional statement per ceiling —
// `UPDATE … SET bytes = bytes + Δ WHERE bytes + Δ <= limit RETURNING …` (as an
// upsert, so a first write creates the row). Postgres re-evaluates that WHERE on
// the latest committed row after waiting for its lock, so two racing writers can
// never both pass a check that only one fits under; zero rows returned rolls the
// whole transaction back as `quota_exceeded`. There is no pre-flight read.
// Every document write is charged to the calling viewer: under `own` only the
// author changes a shared doc, and a private doc is the viewer's.
//
// WHICH CEILINGS A DOCUMENT COUNTS TOWARD is decided by the key space it lives in
// (`scope_uid`), never by the collection's current declaration: a SHARED document
// (`scope_uid = 0`) counts toward the app's ceiling (`usage_app`) and its author's;
// a PRIVATE document (`scope_uid` = its viewer) counts toward its viewer's ceiling
// ONLY. Private writes need no trust gate, so were they charged to the app, a few
// throwaway accounts could fill an app's whole ceiling and refuse every other user.
// A private write still takes `usage_app`'s row lock and the next seq (a zero-byte
// charge), so seq order and the lock order below are unchanged. Because the charge
// follows the stored key space, a collection whose visibility changes between
// manifest versions leaves every existing document where it was charged: the old
// key space is no longer addressed by viewers, its documents stay on the ceilings
// they were charged to, and the account wipe (which deletes by key space) refunds
// exactly those ceilings.
//
// LOCK ORDER, which is what makes it deadlock-free: (1) the document row of the
// one key being written, (2) `usage_app` for (app, ns), (3) the caller's
// `usage_user` row. Nothing takes a document lock after (2), and (3) is only taken
// holding (2), so no cycle can form. A report takes (1) KEY SHARE and no usage lock.
//
// MARKS, COUNTERS, TALLIES AND SERVER-SIDE PUBLISH were removed from the core
// (docs/app-storage-generic-core.md, rollout step 5). Nothing here reads or writes
// `appdata.doc_tally` or `appdata.mark_head` any more (a later hand-applied migration drops
// them); `appdata.doc_mark` holds only reports (`REPORT_MARK`). A collection whose approved
// manifest still declares `marks` or `counters` is served as a plain collection (the
// declaration is inert), and one that declares `write: "none"` is served READ-ONLY
// (`assertShareWritable`), never as `own`.
//
// `seq` comes from `usage_app.last_seq`, incremented in the same statement that
// charges the quota and therefore row-locked until commit: per-(app, ns) seq
// order equals commit order, which is what a future change-feed poller needs.

import { escapeLiteral } from 'pg';
import { POOLER_TRANSIENT_08P01_MESSAGE } from '@civitai/db/db-errors';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { newUlid } from '~/server/utils/app-block-ids';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { validateDocAgainstCollectionSchema } from '~/server/services/apps/doc-store-schema';
import {
  spendHookPass,
  type HookOp,
  type HookPass,
} from '~/server/services/apps/doc-store-hook-pass';
import type { StorageHoldings } from '~/shared/utils/app-storage-usage';
import type {
  AccountWipeNamespaceResult,
  AccountWipeResult,
  DocAuthor,
  DocCollection,
  DocDeleteResult,
  DocIndexType,
  DocListQuery,
  DocLevelGate,
  DocListResult,
  DocRating,
  DocRatingStatus,
  DocRecord,
  DocStoreContext,
  DocStoreLimits,
  DocStoreUsage,
  PublishAction,
  QuotaCeiling,
  WrittenDocRecord,
} from '~/server/services/apps/doc-store.types';
import {
  DEFAULT_DOC_STORE_LIMITS,
  DOC_STORE_BOUNDS as B,
  DocStoreError,
  DocStoreMigrationPendingError,
  isDocStoreError,
  LEVEL_STREAM_BITS,
  REPORT_MARK,
} from '~/server/services/apps/doc-store.types';

// ---------------------------------------------------------------------------
// Connection seam
// ---------------------------------------------------------------------------

export type DocStoreQueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

export type DocStoreClient = {
  query(text: string, params?: unknown[]): Promise<DocStoreQueryResult>;
  release(err?: Error | boolean): void;
};

/** What the store needs from a pool. An `@civitai/db` pool satisfies it (checked below). */
export type DocStoreDb = { connect(): Promise<DocStoreClient> };

type PoolFitsDocStoreDb = AugmentedPool extends DocStoreDb ? true : never;
// Fails `pnpm run typecheck` (true is not assignable to never) if the pool stops fitting.
export const POOL_FITS_DOC_STORE_DB: PoolFitsDocStoreDb = true;

export type DocStoreDeps = {
  /** The least-privilege appdata pool, or null when it is not configured (→ `storage_disabled`). */
  db: DocStoreDb | null;
  limits?: DocStoreLimits;
  /**
   * The per-user ceiling of user `uid`, in place of `limits.userBytes` / `limits.userDocs`.
   * Production wires the viewer's membership-tier caps (`docStoreUserLimits`); read only for a
   * charge that adds bytes or documents to that user, never for one that frees them.
   */
  userLimits?: (uid: number) => Promise<{ userBytes: number; userDocs: number }>;
  /** Called once, the first time the connected role is found to be superuser or BYPASSRLS. */
  onRefused?: (role: { name: string; superuser: boolean; bypassRls: boolean }) => void;
  /**
   * Test-only seam: awaited after a write's document change and before its
   * usage charge — the exact window a pre-flight-read quota would race in. The
   * concurrency test parks every writer here so they all reach the charge
   * together. Never set in production.
   */
  hooks?: {
    beforeUsageCharge?: () => Promise<void>;
  };
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const APP_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * `prod`, `dev:<uid>`, or `rev:<publishRequestId>:<moderatorUid>` — one review namespace per
 * (publish request, reviewing moderator), so moderators reviewing the same request never share
 * documents, marks or counters. A review context's app id IS that publish request id.
 */
const NS_SHAPE = /^(prod|dev:[1-9][0-9]{0,9}|rev:[A-Za-z0-9_-]{1,64}:[1-9][0-9]{0,9})$/;
const REVIEW_NS = /^rev:([A-Za-z0-9_-]{1,64}):([1-9][0-9]{0,9})$/;
const INDEX_NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,2}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function invalid(message: string, details?: Record<string, unknown>): DocStoreError {
  return new DocStoreError('invalid_request', message, details);
}

function assertContext(ctx: DocStoreContext): void {
  // The context is produced by the caller's token resolver; a malformed one is a
  // programming error, never user input — but it is also what every isolation
  // predicate and RLS setting is built from, so refuse it loudly.
  if (!APP_ID_SHAPE.test(ctx.appId)) throw new Error('doc-store: malformed context appId');
  if (!NS_SHAPE.test(ctx.ns)) throw new Error('doc-store: malformed context ns');
  if (ctx.viewerUid !== null && !(Number.isSafeInteger(ctx.viewerUid) && ctx.viewerUid > 0)) {
    throw new Error('doc-store: malformed context viewerUid');
  }
  // A review namespace belongs to one request (the context's app id) and one moderator (the
  // viewer): a context that pairs it with anyone else is refused, whatever built it.
  const review = REVIEW_NS.exec(ctx.ns);
  if (review && (review[1] !== ctx.appId || Number(review[2]) !== ctx.viewerUid)) {
    throw new Error('doc-store: review namespace does not belong to this context');
  }
}

/** The review namespace of one moderator reviewing one publish request. */
export function reviewNamespace(publishRequestId: string, moderatorUid: number): string {
  const ns = `rev:${publishRequestId}:${moderatorUid}`;
  if (!APP_ID_SHAPE.test(publishRequestId) || !REVIEW_NS.test(ns)) {
    throw new Error('doc-store: malformed review namespace');
  }
  return ns;
}

/** (app, ns) pairs read per page by the account wipe's enumeration. */
const ACCOUNT_WIPE_PAGE = 500;

/** A user id the account wipe accepts: a positive integer that fits the `integer` columns. */
function assertWipeUserId(userId: number): void {
  if (!(Number.isSafeInteger(userId) && userId > 0 && userId <= 2_147_483_647)) {
    throw new Error('doc-store: malformed user id');
  }
}

/**
 * Whether `ns` is `userId`'s own dev namespace: only that user's dev tokens resolve to it
 * (`doc-store-access.ts`), so every row in it is theirs and the wipe deletes all of it. A review
 * namespace is not treated so: it belongs to the reviewing moderator, and is purged when the
 * request is decided and by the hourly sweep; the wipe handles it like any other namespace.
 */
function ownsNamespace(userId: number, ns: string): boolean {
  return ns === `dev:${userId}`;
}

type WritePolicy = 'own' | 'owner' | 'none';

/**
 * Validate a collection and return its write policy (shared) — refusing what is not supported
 * yet. Exported so the route refuses an unsupported collection before any other gate runs.
 */
export function assertCollection(coll: DocCollection): WritePolicy {
  if (!B.collectionName.test(coll.name)) throw invalid('invalid collection name');
  if (coll.config.ttlSeconds !== undefined) {
    throw invalid('ttlSeconds is not supported yet', { collection: coll.name });
  }
  // Log collections (server keys, trimmed to maxEntries) are a later phase.
  if (coll.config.kind === 'log' || coll.config.maxEntries !== undefined) {
    throw invalid('log collections are not supported yet', { collection: coll.name });
  }
  if (coll.config.dailyWritesPerAuthor !== undefined) {
    throw invalid('dailyWritesPerAuthor is not supported yet', { collection: coll.name });
  }
  const write = coll.config.write ?? 'own';
  if (write === 'anyone') {
    throw invalid('write: anyone is not supported yet', { collection: coll.name });
  }
  return write;
}

/**
 * Viewers write documents in shared collections only under `own`. Exported so the route
 * layer can refuse BEFORE it spends a write budget token and a moderation scan; the store
 * still runs it itself on every document write.
 *
 * 🔴 `write: "none"` IS READ-ONLY, PERMANENTLY. It existed for counter documents, which were
 * removed (docs/app-storage-generic-core.md, "Manifest fields"), but an approved manifest (or a
 * rollback to one) can still declare it, and the parser keeps it as a policy so it never reads
 * as an absent `write` (= `own`, writable by every eligible viewer).
 */
export function assertShareWritable(
  coll: DocCollection,
  policy: WritePolicy = assertCollection(coll)
) {
  if (coll.config.visibility !== 'shared') return;
  if (policy === 'owner') {
    throw new DocStoreError('write_policy', 'only the app owner writes this collection');
  }
  if (policy === 'none') {
    throw new DocStoreError(
      'write_policy',
      'this collection is read-only: its declared write "none" admits no viewer writes'
    );
  }
}

/**
 * VIEWER-KEYED collections (`keyedBy`, `doc-store-viewer-keyed.ts`): a viewer writes exactly one
 * document per (parent) key, at a key the server derives, so every path that names keys itself or
 * writes beside the document is refused (`invalid_request`, `reason: 'viewer_keyed'`): a create or
 * a write by key (the route). The only writes are the route's `@me` ones. Exported for the route.
 */
export function refuseViewerKeyed(coll: DocCollection, what: string): void {
  if (coll.config.keyedBy === undefined) return;
  throw invalid(
    `${what} is not available on viewer-keyed collection ${coll.name}: write the viewer's own document at /${coll.name}/@me`,
    { reason: 'viewer_keyed', collection: coll.name }
  );
}

/** A key made only of dots (`.`, `..`, …) is a path step to every URL client, not a name. */
const DOT_ONLY_KEY = /^\.+$/;

function assertKey(key: string): void {
  if (typeof key !== 'string' || !B.key.test(key)) {
    throw invalid('key must be 1–128 characters of [A-Za-z0-9._:-]');
  }
  if (DOT_ONLY_KEY.test(key)) {
    throw invalid('key must not consist only of dots: it cannot be addressed in a URL path');
  }
}

function requireViewer(ctx: DocStoreContext): number {
  if (ctx.viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
  return ctx.viewerUid;
}

/** The key space a collection's documents live in for this viewer. */
function scopeUid(ctx: DocStoreContext, coll: DocCollection): number {
  if (coll.config.visibility === 'shared') return 0;
  // Private: one key space per viewer; anonymous viewers have none.
  return requireViewer(ctx);
}

function requireShared(coll: DocCollection, what: string): void {
  if (coll.config.visibility !== 'shared') {
    throw invalid(`${what} exist on shared collections only`);
  }
}

/**
 * PERMISSION HOOKS. A viewer write to a collection whose declaration has a `hook` runs only with
 * a HookPass for exactly this write (`doc-store-hook-pass.ts`), which only the hook gate mints
 * once the hook allowed it. Returns the document version the write is pinned to (the version the
 * hook was shown), or `undefined` for a collection with no hook. A report never comes through
 * here: a hook must never be able to silence moderation reports. The maintenance, moderation and
 * migration writers do not come through here: they are platform operations, not viewer writes
 * (`doc-store-hook.ledger.test.ts` lists every write entry point).
 */
function requireHookPass(
  ctx: DocStoreContext,
  coll: DocCollection,
  op: HookOp,
  key: string,
  pass: HookPass | undefined
): number | undefined {
  if (!coll.config.hook) return undefined;
  return spendHookPass(pass, { appId: ctx.appId, ns: ctx.ns, collection: coll.name, key, op });
}

/**
 * The version a write is checked against: the hook's pinned one when there is a hook, else the
 * caller's own `ifVersion`. Both given and different is a conflict (the gate refuses that before
 * calling the hook, so this is a backstop).
 */
function effectiveIfVersion(
  callerIfVersion: number | undefined,
  pinned: number | undefined
): number | undefined {
  if (pinned === undefined) return callerIfVersion;
  if (callerIfVersion !== undefined && callerIfVersion !== pinned) {
    throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: null });
  }
  return pinned;
}

// ---------------------------------------------------------------------------
// The unchanged-put rule
// ---------------------------------------------------------------------------

/**
 * What a write of `source` over the stored shared document `copy` would do (`PublishAction`). The
 * ONE place this is decided; `putIfUnchanged` answers without writing only on `unchanged`.
 */
export function classifyPublish(
  viewer: number,
  source: { hash: string } | undefined,
  /** The shared row: `author_kind`, `author_uid`, `hidden`, `hash` (`SQL_UNCHANGED_PROBE`). */
  copy: Record<string, unknown> | undefined
): PublishAction {
  if (copy) {
    const mine = copy.author_kind === 'user' && Number(copy.author_uid) === viewer;
    // Someone else's copy, hidden or not, is reported the same way: it is not the caller's.
    if (!mine) return 'not_author';
    if (copy.hidden === true) return 'hidden';
  }
  if (!source) return 'missing';
  if (!copy) return 'create';
  return copy.hash === source.hash ? 'unchanged' : 'update';
}

/** Serialise and bound `data`. Returns the JSON text handed to Postgres. */
function serializeData(data: unknown): string {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalid('data must be a JSON object');
  }
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    throw invalid('data is not serialisable as JSON');
  }
  // The cap binds in the stored unit (the `doc_size_cap` CHECK on
  // `octet_length(data::text)`). For any value JSON.stringify emits, the jsonb
  // text is at least as long (jsonb adds separator spaces and never shortens a
  // number JS printed), so refusing an over-cap wire size here only saves
  // Postgres the parse; it can never refuse a document the CHECK would admit.
  if (Buffer.byteLength(json, 'utf8') > B.docBytes) {
    throw new DocStoreError('too_large', `document exceeds ${B.docBytes} bytes`, {
      limit: B.docBytes,
    });
  }
  assertJsonShape(data, 1);
  return json;
}

function assertStoredString(s: string): void {
  // Postgres text and jsonb cannot hold NUL or an unpaired surrogate; refusing
  // here turns what would be a 500 from the driver into a 400.
  if (s.includes('\u0000') || LONE_SURROGATE.test(s)) {
    throw invalid('data contains a NUL character or an unpaired surrogate');
  }
}

function assertJsonShape(value: unknown, depth: number): void {
  if (typeof value === 'string') return assertStoredString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('data contains a non-finite number');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value !== 'object') throw invalid('data contains a non-JSON value');
  if (depth > B.depth) throw invalid(`data nests deeper than ${B.depth}`);
  if (Array.isArray(value)) {
    for (const v of value) assertJsonShape(v, depth + 1);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw invalid('data contains a non-JSON object');
  for (const [k, v] of Object.entries(value)) {
    assertStoredString(k);
    // JSON.stringify drops undefined members; reject so the stored doc is what was sent.
    if (v === undefined) throw invalid('data contains an undefined value');
    assertJsonShape(v, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Declared indexes
// ---------------------------------------------------------------------------

type IndexRow = { name: string; type: DocIndexType; vText: string | null; vNum: number | null };
type IndexValue = { column: 'v_text' | 'v_num'; value: string | number };

function declaredIndexes(coll: DocCollection): [string, DocIndexType][] {
  const entries = [...coll.config.indexes.entries()];
  if (entries.length > B.indexesPerCollection) {
    throw invalid(`at most ${B.indexesPerCollection} indexes per collection`);
  }
  for (const [name] of entries) {
    if (!INDEX_NAME_SHAPE.test(name)) throw invalid('invalid index name', { index: name });
  }
  return entries;
}

/** A declared index's type. A `Map`, so a request field named `constructor` is simply undeclared. */
function declaredIndexType(coll: DocCollection, field: string): DocIndexType | undefined {
  return coll.config.indexes.get(field);
}

function indexColumn(type: DocIndexType): 'v_text' | 'v_num' {
  return type === 'string' ? 'v_text' : 'v_num';
}

function readPath(data: Record<string, unknown>, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Normalise one index value to its stored column. Used both on write (from the
 * document) and on query (from a filter), so the two cannot disagree.
 * `time` accepts an ISO-8601 string or epoch milliseconds and is stored as epoch ms.
 */
function indexValue(type: DocIndexType, raw: unknown, index: string): IndexValue {
  const bad = (reason: string) => invalid(`index ${index}: ${reason}`, { index });
  switch (type) {
    case 'string': {
      if (typeof raw !== 'string') throw bad('expected a string');
      if (Buffer.byteLength(raw, 'utf8') > B.stringIndexBytes) {
        throw bad(`string longer than ${B.stringIndexBytes} bytes`);
      }
      assertStoredString(raw);
      return { column: 'v_text', value: raw };
    }
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) throw bad('expected a finite number');
      return { column: 'v_num', value: raw };
    case 'boolean':
      if (typeof raw !== 'boolean') throw bad('expected a boolean');
      return { column: 'v_num', value: raw ? 1 : 0 };
    case 'time': {
      const ms =
        typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
      if (!Number.isFinite(ms)) throw bad('expected an ISO-8601 time or epoch milliseconds');
      return { column: 'v_num', value: ms };
    }
  }
}

/**
 * The index rows a document produces. A missing or null value produces no row
 * (the document is then absent from lists filtered or sorted by that index); a
 * present value of the wrong type, or an over-long string, refuses the write —
 * silently skipping it would make the document vanish from filtered lists.
 */
function indexRowsFor(coll: DocCollection, data: Record<string, unknown>): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const [name, type] of declaredIndexes(coll)) {
    const raw = readPath(data, name);
    if (raw === undefined || raw === null) continue;
    const v = indexValue(type, raw, name);
    rows.push(
      v.column === 'v_text'
        ? { name, type, vText: v.value as string, vNum: null }
        : { name, type, vText: null, vNum: v.value as number }
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SQL. Every statement: `$1` is app_id and `$2` is ns, and every reference to an
// `appdata` table carries `<alias>.app_id = $1 AND <alias>.ns = $2` (an INSERT
// writes `$1, $2` into its leading `app_id, ns` columns). Do not add a statement
// that breaks this shape — the isolation scan will fail it.
// ---------------------------------------------------------------------------

/** The connected role's attributes — RLS does not bind a superuser or a BYPASSRLS role. */
const SQL_ROLE_PRIVILEGES = `SELECT r.rolname, r.rolsuper, r.rolbypassrls
  FROM pg_roles r WHERE r.rolname = current_user`;

/**
 * Document columns. With `rating` (content levels on, `DocStoreContext.levels`), also the
 * document's effective level and rating status. No tally and no mark is read: they were removed
 * from the core (docs/app-storage-generic-core.md, rollout step 5).
 */
function docColumns(rating = false): string {
  return `d.key, d.data, d.version, d.created_at, d.updated_at, d.author_uid, d.author_kind${
    rating ? RATING_COLUMNS : ''
  }`;
}

/**
 * What a write answers beside `docColumns` (`WrittenDocRecord`): the document's seq and its
 * record id. Selected only by the statements a write returns its document from, never by a read.
 */
const WRITTEN_COLUMNS = `
    d.seq, d.record_id::text AS record_id`;

/**
 * A document's CURRENT level: the moderator's override when it was given for the document's
 * current `version`, else the rated level when it was rated at that version, else NULL. A rating
 * or override for an older version does not count: every rewrite of the body bumps `version` (a
 * put, a schema migration), so a rating never outlives the content it rated, whoever rewrote it
 * and whether or not levels were on at the time.
 */
const CURRENT_LEVEL = `CASE
      WHEN d.override_level IS NOT NULL AND d.override_version = d.version THEN d.override_level
      WHEN d.level IS NOT NULL AND d.rated_version = d.version THEN d.level
    END`;
/** Rated (or overridden) for the current version. Never NULL. */
const RATED_NOW = `(COALESCE(d.rating_status IN ('rated', 'overridden'), false)
    AND ${CURRENT_LEVEL} IS NOT NULL)`;

/**
 * The rating a reader is shown: the current level and the status. A rating for an older version
 * reads as `pending` with no level; a document never rated reads as NULL.
 */
const RATING_COLUMNS = `,
    CASE WHEN ${RATED_NOW} THEN ${CURRENT_LEVEL} END AS rating_level,
    CASE WHEN ${RATED_NOW} THEN d.rating_status
      WHEN d.rating_status IS NULL THEN NULL
      ELSE 'pending' END AS rating_status`;

/**
 * Transaction-local cap on waiting for ANY lock in a store transaction. The case
 * it exists for: a burst of writes to one app queues on its `usage_app` row, and
 * in a transaction-pooled setup a waiter holds a server connection the whole
 * time; this bounds how long one busy app can hold connections other apps share.
 * It equally bounds waits on a document row (a writer holds FOR UPDATE through
 * that queue, so a mark or increment on a document being edited in the burst can
 * time out too), on a hot tally row, on a conflicting insert, and on relation
 * locks taken by DDL on `appdata`. All of them surface as `rate_limited`.
 */
const LOCK_TIMEOUT = '3s';

/**
 * Hidden (moderated) documents read as not found — a READ guarantee. A WRITE to a
 * hidden key is refused as `not_found` too, but since the same write to a truly
 * absent key would create it, the refusal reveals that the key exists.
 */
const VISIBLE = `d.hidden_at IS NULL`;

/**
 * 🔴 THE content-level predicate: whether document `d` may be returned to the viewer `viewer` whose
 * own browsing level is `level`, on a token whose domain ceiling is `domain` (SQL placeholders;
 * `NULL::int` as `viewer` for a read with no viewer, which then never takes the author arm).
 * Used ONLY while content levels are on (`DocStoreContext.levels`); every statement that returns
 * shared documents to a reader has a levels twin that ANDs this next to `VISIBLE`, and
 * `doc-store.levels-ledger.test.ts` fails when a statement that reads documents is added outside
 * that ledger. ONE definition; never restate it at a call site.
 *
 * Visible when any of:
 * - the document is private (`scope_uid <> 0`): only its owner's key space ever reads it;
 * - the viewer is its user author and it is not rated for its current version (never rated,
 *   `pending`, or rated for an older version): an author always sees what they wrote until it is
 *   rated;
 * - it is rated for its current version (`CURRENT_LEVEL`: the override given for this version,
 *   else the rating given for it) and that level shares a bit with the CAP (the site's bitwise
 *   browsing-level test). The cap is the domain ceiling for the document's own author
 *   (their own R document shows on a red-capable host, not on the SFW one, whatever their own
 *   setting), and the viewer's level for everyone else. A NULL level shares nothing.
 * So an unrated, `pending` or stale-rated document is hidden from everyone but its author, and a
 * `Blocked` (32) one from everyone, its author included, since no browsing level includes it.
 *
 * COALESCE(…, false): never NULL, so `NOT` of it (the feed's `hidden`) is never NULL either.
 */
export function sharedDocLevelVisible(viewer: string, level: string, domain: string): string {
  const isAuthor = `(d.author_kind = 'user' AND d.author_uid = ${viewer})`;
  return `COALESCE(d.scope_uid <> 0
    OR (${isAuthor} AND NOT ${RATED_NOW})
    OR (${RATED_NOW}
      AND (${CURRENT_LEVEL}
        & CASE WHEN ${isAuthor} THEN ${domain} ELSE ${level} END) <> 0), false)`;
}

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 keys
const SQL_GET_MANY = `SELECT ${docColumns()}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.key = ANY($5::text[]) AND ${VISIBLE}`;
// Its levels twin. $5 the viewer, $6 keys, $7 the viewer's level, $8 the token's domain ceiling.
const SQL_GET_MANY_LEVELS = `SELECT ${docColumns(true)}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.key = ANY($6::text[]) AND ${VISIBLE}
    AND ${sharedDocLevelVisible('$5::int', '$7::int', '$8::int')}`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_LOCK_DOC = `SELECT d.version, d.author_uid, d.author_kind, d.size_bytes,
    d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  FOR UPDATE`;

// `putIfUnchanged`'s one read: the stored shared document as a write returns it (SQL_STAMP_SEQ's
// columns), plus what decides whether a put of `$6` would change any stored row:
// - `hash` / `written_hash`: the content hash `classifyPublish` compares (`md5` of jsonb's
//   canonical text, so equal content gives an equal hash), the second taken of `$6::jsonb` exactly as SQL_UPDATE_DOC
//   would store it;
// - `index_same`: the document's stored index rows are exactly the rows SQL_SYNC_INDEX would leave
//   ($7-$10, the same arrays it takes), compared both ways with EXCEPT (NULLs compare equal there).
// Unlocked: nothing is written on its answer, so the answer is simply as of this read.
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 names, $8 v_text, $9 v_num,
// $10 v_type
const SQL_UNCHANGED_PROBE_TAIL = `,${WRITTEN_COLUMNS},
    d.hidden_at IS NOT NULL AS hidden, md5(d.data::text) AS hash,
    md5($6::jsonb::text) AS written_hash,
    NOT EXISTS (
      SELECT ix.name, ix.v_text, ix.v_num, ix.v_type FROM appdata.doc_index ix
        WHERE ix.app_id = $1 AND ix.ns = $2 AND ix.coll = $3 AND ix.scope_uid = $4::int AND ix.key = $5
      EXCEPT
      SELECT * FROM unnest($7::text[], $8::text[], $9::float8[], $10::text[])
    ) AND NOT EXISTS (
      SELECT * FROM unnest($7::text[], $8::text[], $9::float8[], $10::text[])
      EXCEPT
      SELECT ix.name, ix.v_text, ix.v_num, ix.v_type FROM appdata.doc_index ix
        WHERE ix.app_id = $1 AND ix.ns = $2 AND ix.coll = $3 AND ix.scope_uid = $4::int AND ix.key = $5
    ) AS index_same
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5`;
const SQL_UNCHANGED_PROBE = `SELECT ${docColumns()}${SQL_UNCHANGED_PROBE_TAIL}`;
// The same, with its rating (levels on). The writer's own document only: the caller answers with
// it only when `classifyPublish` says the caller authored it, so no gate.
const SQL_UNCHANGED_PROBE_LEVELS = `SELECT ${docColumns(true)}${SQL_UNCHANGED_PROBE_TAIL}`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid
const SQL_INSERT_DOC = `INSERT INTO appdata.doc AS d
    (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid)
  VALUES ($1, $2, $3, $4::int, $5, $6::jsonb, 1, 0, $7::int, 'user', $7::int)
  ON CONFLICT DO NOTHING
  RETURNING d.size_bytes`;

// A shared write while levels are on: the document must be rated again before anyone but its
// author reads it. The level is cleared; a moderator's override, and when it was last rated, are
// kept. $1 app, $2 ns, $3 coll, $4 key
const SQL_RATING_PENDING = `UPDATE appdata.doc d SET rating_status = 'pending', level = NULL
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid
const SQL_UPDATE_DOC = `UPDATE appdata.doc d
  SET data = $6::jsonb, version = d.version + 1, last_writer_uid = $7::int, updated_at = now()
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING d.size_bytes`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_DELETE_DOC = `DELETE FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5`;

// A deleted shared document's reports ($1 app, $2 ns, $3 coll, $4 key).
const SQL_DELETE_MARKS = `DELETE FROM appdata.doc_mark mk
  WHERE mk.app_id = $1 AND mk.ns = $2 AND mk.coll = $3 AND mk.key = $4`;

// Replace a document's index rows in one statement: drop names it no longer has,
// upsert the ones it does. The two touch disjoint rows.
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 names, $7 v_text, $8 v_num, $9 v_type
const SQL_SYNC_INDEX = `WITH gone AS (
    DELETE FROM appdata.doc_index ix
    WHERE ix.app_id = $1 AND ix.ns = $2 AND ix.coll = $3 AND ix.scope_uid = $4::int AND ix.key = $5
      AND NOT (ix.name = ANY($6::text[]))
  )
  INSERT INTO appdata.doc_index AS ix (app_id, ns, coll, scope_uid, key, name, v_text, v_num, v_type)
  SELECT $1, $2, $3, $4::int, $5, u.name, u.v_text, u.v_num, u.v_type
  FROM unnest($6::text[], $7::text[], $8::float8[], $9::text[]) AS u(name, v_text, v_num, v_type)
  ON CONFLICT (app_id, ns, coll, scope_uid, key, name)
  DO UPDATE SET v_text = EXCLUDED.v_text, v_num = EXCLUDED.v_num, v_type = EXCLUDED.v_type`;

// Charge the per-(app, ns) ceiling — shared documents only; a private write passes a
// zero delta — and take the next seq. Zero rows = over quota. A zero or negative
// delta always passes, so a private write, a delete or a shrink is never refused by
// it, even over a ceiling that was lowered.
// $1 app, $2 ns, $3 Δbytes, $4 Δdocs, $5 byte limit, $6 doc limit
const SQL_CHARGE_APP = `INSERT INTO appdata.usage_app AS u (app_id, ns, bytes, docs, last_seq)
  SELECT $1, $2, $3::bigint, $4::int, 1
  WHERE ($3::bigint <= 0 OR $3::bigint <= $5::bigint) AND ($4::int <= 0 OR $4::int <= $6::int)
  ON CONFLICT (app_id, ns) DO UPDATE
  SET bytes = u.bytes + EXCLUDED.bytes, docs = u.docs + EXCLUDED.docs, last_seq = u.last_seq + 1
  WHERE (EXCLUDED.bytes <= 0 OR u.bytes + EXCLUDED.bytes <= $5::bigint)
    AND (EXCLUDED.docs <= 0 OR u.docs + EXCLUDED.docs <= $6::int)
  RETURNING u.last_seq`;

// $1 app, $2 ns, $3 user, $4 Δbytes, $5 Δdocs, $6 byte limit, $7 doc limit
const SQL_CHARGE_USER = `INSERT INTO appdata.usage_user AS u (app_id, ns, user_id, bytes, docs)
  SELECT $1, $2, $3::int, $4::bigint, $5::int
  WHERE ($4::bigint <= 0 OR $4::bigint <= $6::bigint) AND ($5::int <= 0 OR $5::int <= $7::int)
  ON CONFLICT (app_id, ns, user_id) DO UPDATE
  SET bytes = u.bytes + EXCLUDED.bytes, docs = u.docs + EXCLUDED.docs
  WHERE (EXCLUDED.bytes <= 0 OR u.bytes + EXCLUDED.bytes <= $6::bigint)
    AND (EXCLUDED.docs <= 0 OR u.docs + EXCLUDED.docs <= $7::int)
  RETURNING u.bytes`;

// Stamp the seq and return the stored document, with its seq and record id
// (`WrittenDocRecord`, `WRITTEN_COLUMNS`).
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 seq
const SQL_STAMP_SEQ = `UPDATE appdata.doc d SET seq = $6::bigint
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING ${docColumns()},${WRITTEN_COLUMNS}`;
// The same, also stamping the schema major the body was written under (NULL = not known). Only
// once the manual migration `20261106130000_appdata_doc_schema_major.sql` added the column (see
// `hasSchemaMajorColumn`). $7 the major.
const SQL_STAMP_SEQ_MAJOR = `UPDATE appdata.doc d SET seq = $6::bigint, schema_major = $7::int
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING ${docColumns()},${WRITTEN_COLUMNS}`;
// The two above, returning the rating too (levels on). The writer's own document: no gate.
const SQL_STAMP_SEQ_LEVELS = `UPDATE appdata.doc d SET seq = $6::bigint
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING ${docColumns(true)},${WRITTEN_COLUMNS}`;
const SQL_STAMP_SEQ_MAJOR_LEVELS = `UPDATE appdata.doc d SET seq = $6::bigint, schema_major = $7::int
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING ${docColumns(true)},${WRITTEN_COLUMNS}`;
// Whether `appdata.doc.schema_major` exists: fails with undefined_column (42703) until the manual
// migration is applied. Reads no row. Run under a savepoint, so that failure leaves the write's
// transaction usable. $1 app, $2 ns
const SQL_SCHEMA_MAJOR_PROBE = `SELECT d.schema_major FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 LIMIT 0`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 seq
const SQL_TOMBSTONE = `INSERT INTO appdata.doc_tomb AS tb (app_id, ns, coll, scope_uid, key, seq)
  VALUES ($1, $2, $3, $4::int, $5, $6::bigint)
  ON CONFLICT (app_id, ns, coll, scope_uid, key)
  DO UPDATE SET seq = EXCLUDED.seq, deleted_at = now()`;

// A report: shared documents only. KEY SHARE blocks a concurrent delete of the document until
// this transaction ends, without blocking other reporters. $1 app, $2 ns, $3 coll, $4 key
const SQL_SHARE_LOCK_DOC = `SELECT d.version FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
    AND ${VISIBLE}
  FOR KEY SHARE`;

// Server-side lookup of one key across the app's SHARED collections. Hidden rows included, so
// the caller can tell hidden from missing. LIMIT 2 is enough to tell one match from several.
// Only a user-authored document has an author here. $1 app, $2 ns, $3 collection names, $4 key
const SQL_LOOKUP_SHARED_KEY = `SELECT d.coll,
    CASE WHEN d.author_kind = 'user' THEN d.author_uid END AS author_uid,
    d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = ANY($3::text[]) AND d.scope_uid = 0
    AND d.key = $4
  ORDER BY d.coll
  LIMIT 2`;
// Its levels twin: the same `hidden` (a moderator hide only: the lookup stays level-blind, so
// spend attribution never reads a level), plus the rating, which App Store publishing decides on
// (`app-sub-listing.service.ts`: an unrated item is refused, a rated one's card inherits its level).
const SQL_LOOKUP_SHARED_KEY_LEVELS = `SELECT d.coll,
    CASE WHEN d.author_kind = 'user' THEN d.author_uid END AS author_uid,
    d.hidden_at IS NOT NULL AS hidden${RATING_COLUMNS}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = ANY($3::text[]) AND d.scope_uid = 0
    AND d.key = $4
  ORDER BY d.coll
  LIMIT 2`;

// REGISTRY FEED (`createDocStoreFeed`): the SHARED documents (`scope_uid = 0`) of one collection
// of one app namespace, read by seq range, read only. Private documents are never selected: the
// key space is a literal here, never a parameter. Hidden rows come back flagged from the seq read
// (a hide writes a tombstone and leaves the row), and are left out of the full read.
// $1 app, $2 ns
const SQL_FEED_HEAD = `SELECT u.last_seq FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2`;
// $1 app, $2 ns, $3 coll, $4 after seq (exclusive), $5 up to seq (inclusive), $6 limit
const SQL_FEED_DOCS_SINCE = `SELECT d.key, d.data, d.version, d.seq, d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.seq > $4::bigint AND d.seq <= $5::bigint
  ORDER BY d.seq
  LIMIT $6::int`;
// Its levels twin: a document the gate leaves out for the audience's level reads as hidden (a
// delete in the stream). $7 the audience's level.
const SQL_FEED_DOCS_SINCE_LEVELS = `SELECT d.key, d.data, d.version, d.seq,
    (d.hidden_at IS NOT NULL OR NOT ${sharedDocLevelVisible(
      'NULL::int',
      '$7::int',
      '$7::int'
    )}) AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.seq > $4::bigint AND d.seq <= $5::bigint
  ORDER BY d.seq
  LIMIT $6::int`;
// $1 app, $2 ns, $3 coll, $4 after seq (exclusive), $5 up to seq (inclusive), $6 limit
const SQL_FEED_TOMBS_SINCE = `SELECT tb.key, tb.seq FROM appdata.doc_tomb tb
  WHERE tb.app_id = $1 AND tb.ns = $2 AND tb.coll = $3 AND tb.scope_uid = 0
    AND tb.seq > $4::bigint AND tb.seq <= $5::bigint
  ORDER BY tb.seq
  LIMIT $6::int`;
// Every visible shared document, keyset by key. $1 app, $2 ns, $3 coll, $4 after key, $5 up to
// seq (inclusive), $6 limit
const SQL_FEED_DOCS_ALL = `SELECT d.key, d.data, d.version, d.seq FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.hidden_at IS NULL AND d.seq <= $5::bigint AND d.key > $4::text
  ORDER BY d.key
  LIMIT $6::int`;
// Its levels twin. $7 the audience's level.
const SQL_FEED_DOCS_ALL_LEVELS = `SELECT d.key, d.data, d.version, d.seq FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.hidden_at IS NULL AND d.seq <= $5::bigint AND d.key > $4::text
    AND ${sharedDocLevelVisible('NULL::int', '$7::int', '$7::int')}
  ORDER BY d.key
  LIMIT $6::int`;
// $1 app, $2 ns, $3 coll, $4 key
const SQL_FEED_WITNESS_DOC = `SELECT d.seq FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;
const SQL_FEED_WITNESS_TOMB = `SELECT tb.seq FROM appdata.doc_tomb tb
  WHERE tb.app_id = $1 AND tb.ns = $2 AND tb.coll = $3 AND tb.scope_uid = 0 AND tb.key = $4`;

// LEVEL STREAMS (`registry-adapter/level-feed.ts`): the registry feed's reads for the shared-
// collection level streams (`apps/app-data-go/WRITES-DESIGN.md`, "The shape: one stream per level
// bit"; `docs/app-storage-generic-core.md`, "Registry and app-data-go impact"). Shared documents
// (`scope_uid = 0`) of one collection of one app namespace, each as a PLAIN document: its key,
// body, version, seq and timestamps. Never its author or anyone's reports. A viewer-keyed
// document (`keyedBy`) is one of these like any other: its key is the opaque `<parent>:<digest>`
// the REST list also returns, and its author is not read. Two selectors, each its own statement
// so every predicate is a literal:
//   - BIT: rated for its current version at exactly the one level bit `$bit`, through THE level
//     predicate (`sharedDocLevelVisible` with no viewer, so its author arm never applies: an
//     unrated, pending or stale-rated document is on no bit's stream);
//   - NONE: every visible document (content levels OFF for the app: the adapter serves it only
//     then).
// Hidden documents are never on a stream. The seq read flags each row `on_stream`, so a write
// that moved a document off the stream reads as leaving it.
const LEVEL_STREAM_COLUMNS = `d.key, d.data, d.version, d.seq, d.created_at, d.updated_at`;
const LEVEL_ON_BIT = (bit: string) => sharedDocLevelVisible('NULL::int', bit, bit);
// The seq range (`after`, `upTo`]. $1 app, $2 ns, $3 coll, $4 after seq, $5 up to seq, $6 limit
// (+ $7 the bit)
const SQL_LEVEL_DOCS_SINCE_BIT = `SELECT ${LEVEL_STREAM_COLUMNS},
    (d.hidden_at IS NULL AND ${LEVEL_ON_BIT('$7::int')}) AS on_stream
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.seq > $4::bigint AND d.seq <= $5::bigint
  ORDER BY d.seq
  LIMIT $6::int`;
const SQL_LEVEL_DOCS_SINCE_NONE = `SELECT ${LEVEL_STREAM_COLUMNS},
    d.hidden_at IS NULL AS on_stream
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.seq > $4::bigint AND d.seq <= $5::bigint
  ORDER BY d.seq
  LIMIT $6::int`;
// The stream's documents at or below `upTo`, NEWEST KEY FIRST, keyset before `$4` ('' = from the
// newest). $1 app, $2 ns, $3 coll, $4 before key, $5 up to seq, $6 limit (+ $7 the bit)
const SQL_LEVEL_DOCS_DESC_BIT = `SELECT ${LEVEL_STREAM_COLUMNS}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.hidden_at IS NULL AND d.seq <= $5::bigint AND ($4::text = '' OR d.key < $4::text)
    AND ${LEVEL_ON_BIT('$7::int')}
  ORDER BY d.key DESC
  LIMIT $6::int`;
const SQL_LEVEL_DOCS_DESC_NONE = `SELECT ${LEVEL_STREAM_COLUMNS}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.hidden_at IS NULL AND d.seq <= $5::bigint AND ($4::text = '' OR d.key < $4::text)
  ORDER BY d.key DESC
  LIMIT $6::int`;

// PRIVATE FEED (`createDocStorePrivateFeed`): ONE user's private documents (`scope_uid` = that
// user, never 0, never another user's) of one collection of one app's production namespace, for
// the registry adapter's authorized private streams. Only rows that carry a `record_id` (the id
// in a private record's URN) and that moderation has not hidden. Keyset by key.
// $1 app, $2 ns, $3 coll, $4 user, $5 after key, $6 limit
const SQL_PRIVATE_FEED_VERSIONS = `SELECT d.key, d.version, d.record_id::text AS record_id, d.seq
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.hidden_at IS NULL AND d.record_id IS NOT NULL AND d.key > $5::text
  ORDER BY d.key
  LIMIT $6::int`;
// Its full twin: the same rows with their data.
const SQL_PRIVATE_FEED_DOCS = `SELECT d.key, d.data, d.version, d.record_id::text AS record_id, d.seq
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.hidden_at IS NULL AND d.record_id IS NOT NULL AND d.key > $5::text
  ORDER BY d.key
  LIMIT $6::int`;

// A report (`name` = `REPORT_MARK`, the only name written). It carries no payload: the table's
// nullable `reason` column is never written. $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 user
const SQL_INSERT_MARK = `INSERT INTO appdata.doc_mark AS mk (app_id, ns, coll, key, name, user_id)
  VALUES ($1, $2, $3, $4, $5, $6::int)
  ON CONFLICT DO NOTHING
  RETURNING 1 AS inserted`;

// Stored usage. $1 app, $2 ns (+ $3 user). A missing row is zero.
const SQL_USAGE_APP = `SELECT u.bytes, u.docs FROM appdata.usage_app u
  WHERE u.app_id = $1 AND u.ns = $2`;
const SQL_USAGE_USER = `SELECT u.bytes, u.docs FROM appdata.usage_user u
  WHERE u.app_id = $1 AND u.ns = $2 AND u.user_id = $3::int`;

// Review maintenance (see the module header). Every row of every review namespace of one
// publish request, table by table, in the store's lock order (document first — its index rows
// go with it by the foreign-key cascade — then reports, then the maintenance runs, then
// usage_app before usage_user), so a write racing the purge cannot
// deadlock against it. (The store writes maintenance runs in the production namespace only.)
// $1 publish request id. Each returns the number of rows it deleted.
const SQL_REVIEW_PURGE = [
  `WITH gone AS (DELETE FROM appdata.doc d WHERE d.app_id = $1 AND d.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_index ix WHERE ix.app_id = $1 AND ix.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tomb tb WHERE tb.app_id = $1 AND tb.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.maint_run mr WHERE mr.app_id = $1 AND mr.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_user u WHERE u.app_id = $1 AND u.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
] as const;

// The publish requests that still have review data, in id order after a keyset cursor. From
// `usage_app` AND `doc`: a document inserted by a write that overlapped a purge can commit
// after the purge deleted its namespace's `usage_app` row, leaving a document with no usage
// row; reports and index rows exist only beside a document, and a tombstone's write
// holds the document's lock, which the purge waits for. $1 cursor (exclusive), $2 limit.
const SQL_REVIEW_APP_IDS = `SELECT r.app_id FROM (
    SELECT u.app_id FROM appdata.usage_app u WHERE u.ns LIKE 'rev:%' AND u.app_id > $1
    UNION
    SELECT d.app_id FROM appdata.doc d WHERE d.ns LIKE 'rev:%' AND d.app_id > $1
  ) r ORDER BY r.app_id LIMIT $2::int`;

// ACCOUNT WIPE (see the module header and `wipeAccount`).
//
// The (app, ns) pairs in which one user has rows that name them, in key order after a keyset
// cursor. Two sources suffice: every document that names a user — their private documents and the
// shared documents they authored — is charged to that user's `usage_user` row in the same
// transaction that writes it (the invariant `assertUsageConsistent` checks in every suite), and a
// report names its user in `doc_mark`. Run
// only inside `accountWipeTx`. $1 user id, $2 app id and $3 ns of the cursor (exclusive), $4 limit.
const SQL_ACCOUNT_NAMESPACES = `SELECT w.app_id, w.ns FROM (
    SELECT wu.app_id, wu.ns FROM appdata.usage_user wu WHERE wu.user_id = $1::int
    UNION
    SELECT wm.app_id, wm.ns FROM appdata.doc_mark wm WHERE wm.user_id = $1::int
  ) w WHERE (w.app_id, w.ns) > ($2::text, $3::text)
  ORDER BY w.app_id, w.ns LIMIT $4::int`;

// The wipe of ONE (app, ns), in an ordinary scoped transaction. $1 app, $2 ns, $3 user id.
// Statement order follows the store's LOCK ORDER: document rows, then report rows, then
// `usage_app` (taken by `charge`), then `usage_user` — except one second pass over the documents
// at the end, whose reason and cost are at its call in `wipeAccountNamespace`.

// The account's own dev namespace (`dev:<uid>`): only that user ever writes there, so everything
// in it goes, table by table (index rows by the document cascade). Review namespaces are not
// treated so: they belong to the reviewing moderator and are purged with their request.
const SQL_WIPE_NAMESPACE = [
  `WITH gone AS (DELETE FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_index ix WHERE ix.app_id = $1 AND ix.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tomb tb WHERE tb.app_id = $1 AND tb.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.maint_run mr WHERE mr.app_id = $1 AND mr.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_user u WHERE u.app_id = $1 AND u.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
] as const;

// Any other namespace (`prod`, a review namespace): only what names the user.
// The user's private documents; their index rows go by the cascade. Private documents have no
// reports, and get no tombstone: the only reader of a private key space is its owner.
const SQL_WIPE_PRIVATE_DOCS = `WITH gone AS (DELETE FROM appdata.doc d
    WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = $3::int RETURNING d.size_bytes)
  SELECT count(*)::int AS docs, COALESCE(sum(gone.size_bytes), 0)::bigint AS bytes FROM gone`;
// EVERY shared document the wipe will touch in this namespace — the ones the user authored
// (hidden or not), which it deletes, and the ones the user reported, whose report rows it deletes —
// locked in ONE statement, in (coll, key) order. Two wipes of users who authored and reported each
// other's documents then queue on the first document they share instead of each holding its own
// author's documents and waiting for the other's: with the authored set and the reported set
// locked by separate statements, that deadlocked every time on a real server.
// FOR UPDATE for both sets: the authored ones are deleted, which needs it, and a single statement
// has a single strength. The cost: a viewer reporting one of those documents waits for the wipe
// to commit (bounded by LOCK_TIMEOUT).
// After this statement, the only document rows the wipe writes are (a) shared documents in this
// lock set, deleted by `deleteLockedSharedDocs` (authored), and (b) the user's own PRIVATE
// documents (`SQL_WIPE_PRIVATE_DOCS`, `scope_uid` = the user), which no other wipe ever locks:
// every other wipe's lock set is shared documents only. Every report row it deletes belongs to a
// document in this set, except a document the user's own in-flight write commits between
// statements, which the second pass locks. `authored` marks the documents to delete: the same
// delete path a moderator delete takes.
const SQL_WIPE_LOCK_DOCS = `SELECT d.coll, d.key, d.size_bytes, d.author_uid,
    (d.author_kind = 'user' AND d.author_uid = $3::int) AS authored
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = 0
    AND ((d.author_kind = 'user' AND d.author_uid = $3::int)
      OR EXISTS (SELECT 1 FROM appdata.doc_mark lm
        WHERE lm.app_id = $1 AND lm.ns = $2 AND lm.coll = d.coll AND lm.key = d.key
          AND lm.user_id = $3::int))
  ORDER BY d.coll, d.key
  FOR UPDATE OF d`;
// The user's `doc_mark` rows: their reports (and any row a removed mark left, which the
// hand-applied cleanup deletes too).
const SQL_WIPE_MARKS = `WITH gone AS (DELETE FROM appdata.doc_mark mk
    WHERE mk.app_id = $1 AND mk.ns = $2 AND mk.user_id = $3::int
    RETURNING 1)
  SELECT count(*)::int AS marks FROM gone`;
// Tombstones of the user's private documents carry their uid as `scope_uid`. After `usage_app`,
// where every writer of a tombstone takes it.
const SQL_WIPE_PRIVATE_TOMBS = `DELETE FROM appdata.doc_tomb tb
  WHERE tb.app_id = $1 AND tb.ns = $2 AND tb.scope_uid = $3::int`;
// The user's usage row: every byte it counted is gone (deleted documents).
const SQL_WIPE_USAGE_USER = `DELETE FROM appdata.usage_user u
  WHERE u.app_id = $1 AND u.ns = $2 AND u.user_id = $3::int`;

// APP PURGE (see the module header and `purgeApp`).
//
// Whether the app-purge policy (migration `20261102120000_appdata_app_purge.sql`) is installed on
// both tables the enumeration reads. Without it the enumeration's setting matches no policy and
// reads as "this app has no namespaces", which would let a purge report an app done while every
// row of it is still there; `listAppNamespaces` refuses instead.
const SQL_APP_PURGE_POLICY = `SELECT count(*)::int AS n FROM pg_catalog.pg_policies pp
  WHERE pp.policyname = 'appdata_app_purge_read' AND pp.tablename IN ('doc', 'usage_app')`;
// The namespaces one app has rows in, in key order after a keyset cursor. Two sources suffice for
// the reason `SQL_REVIEW_APP_IDS` gives: every write takes its namespace's `usage_app` row, and a
// document outlives that row only when its write overlapped a namespace delete; reports and
// index rows exist only beside a document. Run only inside `appPurgeTx`. $1 app id, $2 ns of
// the cursor (exclusive), $3 limit.
const SQL_APP_NAMESPACES = `SELECT p.ns FROM (
    SELECT pu.ns FROM appdata.usage_app pu WHERE pu.app_id = $1 AND pu.ns > $2::text
    UNION
    SELECT pd.ns FROM appdata.doc pd WHERE pd.app_id = $1 AND pd.ns > $2::text
  ) p ORDER BY p.ns LIMIT $3::int`;
// One batch of an app purge's delete of one (app, ns), in an ordinary scoped transaction: at most
// $3 rows of one table. Documents first (their index rows go by the cascade), then the rows that
// sit beside documents; `SQL_WIPE_NAMESPACE` then removes what is left, usage rows included, in
// one last transaction. $1 app, $2 ns, $3 batch size.
const SQL_APP_PURGE_BATCH = [
  `WITH gone AS (DELETE FROM appdata.doc d WHERE d.app_id = $1 AND d.ns = $2
    AND d.ctid = ANY (ARRAY(SELECT bd.ctid FROM appdata.doc bd
      WHERE bd.app_id = $1 AND bd.ns = $2 LIMIT $3::int))
    RETURNING 1) SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns = $2
    AND mk.ctid = ANY (ARRAY(SELECT bm.ctid FROM appdata.doc_mark bm
      WHERE bm.app_id = $1 AND bm.ns = $2 LIMIT $3::int))
    RETURNING 1) SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tomb tb WHERE tb.app_id = $1 AND tb.ns = $2
    AND tb.ctid = ANY (ARRAY(SELECT bb.ctid FROM appdata.doc_tomb bb
      WHERE bb.app_id = $1 AND bb.ns = $2 LIMIT $3::int))
    RETURNING 1) SELECT count(*)::int AS n FROM gone`,
] as const;

// SCHEMA MIGRATION (see `migrateDocuments`). Ordinary (app, ns)-scoped statements, run in
// ordinary `withTx` transactions bound to the app's production namespace.
//
// One page of a collection's documents — every key space (private and shared), hidden ones
// included — in (scope_uid, key) order after a keyset cursor. Keys only: each document is then
// re-read under its own lock. $1 app, $2 ns, $3 coll, $4 scope_uid and $5 key of the cursor
// (exclusive), $6 limit.
const SQL_MIGRATE_PAGE = `SELECT d.scope_uid, d.key, d.author_uid, d.author_kind FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3
    AND (d.scope_uid, d.key) > ($4::int, $5::text COLLATE "C")
  ORDER BY d.scope_uid, d.key LIMIT $6::int`;
// One document with what its migration needs, locked (LOCK ORDER (1)).
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_MIGRATE_LOCK_DOC = `SELECT d.data, d.size_bytes, d.author_uid, d.author_kind
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  FOR UPDATE`;
// The migrated body. A new version (a client holding the old one gets `version_conflict`), and
// the last writer is kept: no viewer wrote this. $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key,
// $6 data
const SQL_MIGRATE_DOC = `UPDATE appdata.doc d
  SET data = $6::jsonb, version = d.version + 1, updated_at = now()
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING d.size_bytes`;

// MAINTENANCE RUNS (`appdata.maint_run`, the manual migration
// `20261123120000_appdata_maint_run.sql`): the record of each rollout step 4 MARK MIGRATION (its
// freeze, copy and verify) and PER-COLLECTION PURGE (with its dump). The tooling that wrote them is
// removed (`docs/app-storage-generic-core.md`, rollout step 5); what is left reads the runs
// (`listMaintRuns`, `purgeDump`), expires the dumps after their retention (`expireMaintDumps`) and
// scrubs a deleted account out of them (`scrubMaintRuns`). Ordinary (app, ns)-scoped statements, run
// in ordinary `withTx` transactions bound to the app's production namespace.
//
// Every run of the namespace (mark migrations and purge headers), without the dump rows.
// $1 app, $2 ns
const SQL_MAINT_RUN_LIST = `SELECT mr.coll, mr.kind, mr.name, mr.status, mr.params, mr.result,
    mr.actor_uid, mr.created_at, mr.updated_at
  FROM appdata.maint_run mr
  WHERE mr.app_id = $1 AND mr.ns = $2 AND mr.kind <> 'purge_dump'
  ORDER BY mr.created_at, mr.coll, mr.kind, mr.name`;
// One purge's batch dumps, in batch order (each named `<run id>.<batch>`). $1 app, $2 ns, $3 coll,
// $4 the name pattern `<run id>.%`
const SQL_MAINT_RUN_DUMPS = `SELECT mr.name, mr.dump FROM appdata.maint_run mr
  WHERE mr.app_id = $1 AND mr.ns = $2 AND mr.coll = $3 AND mr.kind = 'purge_dump'
    AND mr.name LIKE $4 AND mr.dump IS NOT NULL
  ORDER BY mr.name`;
/**
 * THE one predicate "this run names user `uid`" (a SQL int expression): as a dumped document's
 * author, last writer or hider, as a dumped mark's (or report's) user, in a purge's refunds, a
 * copy's over-ceiling list or a verify's per-user sample. The account wipe finds and scrubs runs by
 * it; the migration's `appdata_account_wipe_read` policy on `maint_run` spells the same paths.
 */
function maintRunNamesUser(alias: string, uid: string): string {
  const vars = `jsonb_build_object('u', ${uid}, 's', (${uid})::text)`;
  return `(jsonb_path_exists(${alias}.dump, '$.docs[*] ? (@.authorUid == $u || @.lastWriterUid == $u || @.hiddenBy == $u)', ${vars})
      OR jsonb_path_exists(${alias}.dump, '$.marks[*] ? (@.userId == $u)', ${vars})
      OR jsonb_path_exists(${alias}.result, '$.refunds[*] ? (@.userId == $u)', ${vars})
      OR jsonb_path_exists(${alias}.result, '$.totals.refunds[*] ? (@.userId == $u)', ${vars})
      OR jsonb_path_exists(${alias}.result, '$.copy.overCeiling[*] ? (@ == $u)', ${vars})
      OR jsonb_path_exists(${alias}.result, '$.verify.userSample[*] ? (@.id == $s)', ${vars}))`;
}
// The runs naming one user, locked (the account wipe's scrub). $1 app, $2 ns, $3 user
const SQL_MAINT_RUN_NAMING_USER = `SELECT mr.coll, mr.kind, mr.name, mr.dump, mr.result
  FROM appdata.maint_run mr
  WHERE mr.app_id = $1 AND mr.ns = $2 AND ${maintRunNamesUser('mr', '$3::int')}
  ORDER BY mr.coll, mr.kind, mr.name
  FOR UPDATE`;
// ACCOUNT-WIPE ENUMERATION of the maintenance runs: the (app, ns) pairs whose runs name one user,
// keyset-paged like `SQL_ACCOUNT_NAMESPACES`, so a user who only REPORTED a document that a purge
// then dumped is still found. Run only inside `accountWipeTx`, whose maint_run policy admits the
// rows naming that ONE user, read only. $1 user id, $2 app id and $3 ns of the cursor (exclusive),
// $4 limit.
const SQL_ACCOUNT_DUMP_NAMESPACES = `SELECT DISTINCT wr.app_id, wr.ns FROM appdata.maint_run wr
  WHERE ${maintRunNamesUser('wr', '$1::int')}
    AND (wr.app_id, wr.ns) > ($2::text, $3::text)
  ORDER BY wr.app_id, wr.ns LIMIT $4::int`;
// The scrubbed dump and result; `updated_at` is left alone (it dates the run, and a dump's expiry
// counts from its purge header's). $1 app, $2 ns, $3 coll, $4 kind, $5 name, $6 dump, $7 result
const SQL_MAINT_RUN_SCRUB = `UPDATE appdata.maint_run mr SET dump = $6::jsonb, result = $7::jsonb
  WHERE mr.app_id = $1 AND mr.ns = $2 AND mr.coll = $3 AND mr.kind = $4 AND mr.name = $5`;
// Retention: a purge left `purging` (never finished) $3 days after it STARTED is `abandoned`;
// a re-call starts a new one. $1 app, $2 ns, $3 days
const SQL_MAINT_RUN_ABANDON_PURGES = `UPDATE appdata.maint_run mr SET status = 'abandoned'
  WHERE mr.app_id = $1 AND mr.ns = $2 AND mr.kind = 'purge' AND mr.status = 'purging'
    AND mr.created_at < now() - make_interval(days => $3::int)`;
// The dump rows of every purge that finished $3 days ago or more, or was abandoned.
// $1 app, $2 ns, $3 days
const SQL_MAINT_RUN_EXPIRE_DUMPS = `WITH gone AS (DELETE FROM appdata.maint_run mr
    WHERE mr.app_id = $1 AND mr.ns = $2 AND mr.kind = 'purge_dump'
      AND EXISTS (SELECT 1 FROM appdata.maint_run hr
        WHERE hr.app_id = $1 AND hr.ns = $2 AND hr.coll = mr.coll AND hr.kind = 'purge'
          AND mr.name LIKE hr.name || '.%'
          AND (hr.status = 'abandoned'
            OR (hr.status = 'purged' AND hr.updated_at < now() - make_interval(days => $3::int))))
    RETURNING 1)
  SELECT count(*)::int AS n FROM gone`;
// VIEWER DATA (see `createDocStoreViewerData`).
//
// One user's PRODUCTION usage rows, in app order after a keyset cursor: the apps the user holds
// documents in, for their account settings. The account-wipe enumeration's shape (read only,
// `usage_user` only, keyed on the user) in the same `accountWipeTx`, whose policy admits that
// one user's rows and nothing else. `usage_user_user_idx` (the optional migration 20261102120000)
// serves the key once applied; every document a user owns is charged to this row (`assertUsageConsistent`), so a row
// with no documents holds none. `'prod'` is `PUBLISHED_NS`. $1 user id, $2 app id of the cursor
// (exclusive), $3 limit.
const SQL_VIEWER_PROD_USAGE = `SELECT vu.app_id, vu.bytes, vu.docs FROM appdata.usage_user vu
  WHERE vu.user_id = $1::int AND vu.ns = 'prod' AND vu.docs > 0 AND vu.app_id > $2::text
  ORDER BY vu.app_id LIMIT $3::int`;
// One page of the documents ONE user owns in one app's production namespace, for their export
// (`viewerRecords`): their private documents (`scope_uid` = the user) and the visible shared
// documents they created (`author_kind = 'user'`), the two cells of the record core's owner rule
// that name a user (`recordOwner` in `app-record.ts`). Never another user's private key space,
// never a counter or app document, never a document moderation hid. In (coll, scope_uid, key)
// order after a keyset cursor, whatever the app's status.
const SQL_VIEWER_RECORDS = `SELECT d.coll, d.scope_uid, d.key, d.data, d.version, d.author_kind,
    d.author_uid, d.last_writer_uid, d.record_id::text AS record_id
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2
    AND (d.scope_uid = $3::int
      OR (d.scope_uid = 0 AND d.author_kind = 'user' AND d.author_uid = $3::int AND ${VISIBLE}))
    AND (d.coll, d.scope_uid, d.key) > ($4::text COLLATE "C", $5::int, $6::text COLLATE "C")
  ORDER BY d.coll, d.scope_uid, d.key
  LIMIT $7::int`;

// Emptying one viewer's data in one (app, ns), in an ordinary scoped transaction. $1 app, $2 ns,
// $3 the viewer.
// Their private documents (index rows go by the cascade; private documents have no reports),
// returning what the tombstones and the refund need.
const SQL_EMPTY_PRIVATE_DOCS = `WITH gone AS (DELETE FROM appdata.doc d
    WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = $3::int
    RETURNING d.coll, d.key, d.size_bytes)
  SELECT gone.coll, gone.key, gone.size_bytes FROM gone ORDER BY gone.coll, gone.key`;
// The visible shared documents the viewer authored, locked in one ordered statement before
// anything is deleted (LOCK ORDER (1)). A hidden one is left for moderation, as an author
// delete leaves it (`remove` answers `not_found`).
const SQL_EMPTY_LOCK_AUTHORED = `SELECT d.coll, d.key, d.size_bytes, d.author_uid
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = 0 AND d.author_kind = 'user'
    AND d.author_uid = $3::int AND ${VISIBLE}
  ORDER BY d.coll, d.key
  FOR UPDATE OF d`;
// What one viewer's usage in one (app, ns) is made of, by what an empty does with it, in an
// ordinary scoped transaction. $1 app, $2 ns, $3 the viewer. Exactly the documents charged to
// their usage row (`assertUsageConsistent`): their private documents (`private`, every empty
// deletes them), the shared documents they authored (`shared` when visible, deleted on request;
// `hidden` when moderation hid them, which an empty leaves).
const SQL_VIEWER_HOLDINGS = `SELECT
    CASE WHEN d.scope_uid = $3::int THEN 'private'
      WHEN ${VISIBLE} THEN 'shared'
      ELSE 'hidden' END AS part,
    count(*)::int AS docs, COALESCE(sum(d.size_bytes), 0)::bigint AS bytes
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2
    AND (d.scope_uid = $3::int
      OR (d.scope_uid = 0 AND d.author_kind = 'user' AND d.author_uid = $3::int))
  GROUP BY 1`;
// One tombstone per deleted key, all at one seq. $1 app, $2 ns, $3 scope_uid, $4 seq,
// $5 collections, $6 keys (parallel arrays).
const SQL_TOMBSTONE_MANY = `INSERT INTO appdata.doc_tomb AS tb (app_id, ns, coll, scope_uid, key, seq)
  SELECT $1, $2, g.coll, $3::int, g.key, $4::bigint FROM unnest($5::text[], $6::text[]) AS g(coll, key)
  ON CONFLICT (app_id, ns, coll, scope_uid, key)
  DO UPDATE SET seq = EXCLUDED.seq, deleted_at = now()`;

// List fragments. Aliases are fixed so every fragment's predicates are visible
// to the static isolation scan; only parameter placeholders are interpolated.
// $1 app, $2 ns, $3 coll, $4 scope_uid; `joins` are the fragments below.
const listBase = (joins: string) => `FROM appdata.doc d
  ${joins}
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND ${VISIBLE}`;
// Both index joins match `v_type` to the DECLARED type, so only rows written
// under the current type of an index take part. Number, boolean and time share
// `v_num`, so a value-column check alone cannot tell a `1` written as a number
// from a `true` written as a boolean. The table's `doc_index_value_column` CHECK
// guarantees the declared type's column is non-NULL, so sort values never are.
const listEqualityJoin = (
  name: string,
  type: string,
  col: string,
  value: string
) => `JOIN appdata.doc_index ix
    ON ix.app_id = $1 AND ix.ns = $2 AND ix.coll = d.coll AND ix.scope_uid = d.scope_uid
    AND ix.key = d.key AND ix.name = ${name} AND ix.v_type = ${type} AND ix.${col} = ${value}`;
const listSortIndexJoin = (name: string, type: string) => `JOIN appdata.doc_index sx
    ON sx.app_id = $1 AND sx.ns = $2 AND sx.coll = d.coll AND sx.scope_uid = d.scope_uid
    AND sx.key = d.key AND sx.name = ${name} AND sx.v_type = ${type}`;
// `SQL_CHARGE_APP` for a transaction that changes several documents at once: `last_seq` moves
// by $7, one seq per changed document, and the caller numbers them `last_seq - $7 + 1 …
// last_seq`. Same ceilings, same row lock.
// $1 app, $2 ns, $3 Δbytes, $4 Δdocs, $5 byte limit, $6 doc limit, $7 seqs taken
const SQL_CHARGE_APP_SEQS = `INSERT INTO appdata.usage_app AS u (app_id, ns, bytes, docs, last_seq)
  SELECT $1, $2, $3::bigint, $4::int, $7::bigint
  WHERE ($3::bigint <= 0 OR $3::bigint <= $5::bigint) AND ($4::int <= 0 OR $4::int <= $6::int)
  ON CONFLICT (app_id, ns) DO UPDATE
  SET bytes = u.bytes + EXCLUDED.bytes, docs = u.docs + EXCLUDED.docs, last_seq = u.last_seq + $7::bigint
  WHERE (EXCLUDED.bytes <= 0 OR u.bytes + EXCLUDED.bytes <= $5::bigint)
    AND (EXCLUDED.docs <= 0 OR u.docs + EXCLUDED.docs <= $6::int)
  RETURNING u.last_seq`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/**
 * A document row's author as a reader sees it: a user-authored document is the user's, marked when
 * it is the viewer; anything else (an app document, one whose author uid is gone) the app's.
 */
function rowAuthor(row: Record<string, unknown>, viewerUid: number | null): DocAuthor {
  const authorUid = row.author_uid === null ? null : Number(row.author_uid);
  if (row.author_kind !== 'user' || authorUid === null) return { kind: 'app' };
  return { kind: 'user', uid: authorUid, isViewer: authorUid === viewerUid };
}

function toDocRecord(row: Record<string, unknown>, ctx: DocStoreContext): DocRecord {
  return {
    key: row.key as string,
    data: row.data as Record<string, unknown>,
    version: Number(row.version),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
    author: rowAuthor(row, ctx.viewerUid),
    ...(ctx.levels ? { rating: toDocRating(row) } : {}),
  };
}

/** A row a write returned its document from (`WRITTEN_COLUMNS`), as the write answers it. */
function toWrittenDocRecord(row: Record<string, unknown>, ctx: DocStoreContext): WrittenDocRecord {
  return {
    ...toDocRecord(row, ctx),
    seq: Number(row.seq),
    recordId: row.record_id === null || row.record_id === undefined ? null : String(row.record_id),
  };
}

const RATING_STATUSES: ReadonlySet<string> = new Set<DocRatingStatus>([
  'pending',
  'rated',
  'overridden',
]);

/** The rating columns (`RATING_COLUMNS`) as a reader sees them. */
function toDocRating(row: Record<string, unknown>): DocRating {
  const level =
    row.rating_level === null || row.rating_level === undefined ? null : Number(row.rating_level);
  const status =
    typeof row.rating_status === 'string' && RATING_STATUSES.has(row.rating_status)
      ? (row.rating_status as DocRatingStatus)
      : null;
  return { level, status };
}

// ---------------------------------------------------------------------------
// List: sort and cursor
// ---------------------------------------------------------------------------

type SortSpec =
  | { kind: 'key'; desc: boolean }
  | { kind: 'createdAt' | 'updatedAt'; desc: boolean }
  | { kind: 'index'; desc: boolean; name: string; type: DocIndexType };

function parseSort(coll: DocCollection, raw: string | undefined): SortSpec {
  const s = raw ?? 'key';
  const desc = s.startsWith('-');
  const field = desc ? s.slice(1) : s;
  if (field === 'key') return { kind: 'key', desc };
  if (field === 'createdAt' || field === 'updatedAt') return { kind: field, desc };
  const type = declaredIndexType(coll, field);
  if (!type) {
    throw new DocStoreError('index_not_declared', `sort field ${field} is not declared`, { field });
  }
  return { kind: 'index', desc, name: field, type };
}

const CURSOR_SEP = '~';

function sortTag(sort: SortSpec): string {
  const dir = sort.desc ? 'd' : 'a';
  switch (sort.kind) {
    case 'key':
      return `k${dir}`;
    case 'createdAt':
      return `c${dir}`;
    case 'updatedAt':
      return `u${dir}`;
    case 'index':
      return `${indexColumn(sort.type) === 'v_text' ? 's' : 'n'}${dir}`;
  }
}

/**
 * Cursor = `<kind><dir>~<payload>~<lastKey>`: a keyset bound, not a capability —
 * it carries nothing the caller could not already send as a filter, so it is not
 * bound to the query that issued it. The payload is base64url of the UTF-8 sort
 * value for a string index (≤128 bytes → ≤171 chars), a decimal number
 * otherwise, empty for `key`; the key is raw (ASCII, ≤128, and `~` is not in its
 * alphabet). Worst case 2+1+171+1+128 = 303 chars, under the 512 the server
 * accepts — so the server can never issue a cursor it would itself refuse.
 */
function encodeCursor(sort: SortSpec, value: string, key: string): string {
  const payload =
    sort.kind === 'index' && sort.type === 'string'
      ? Buffer.from(value, 'utf8').toString('base64url')
      : value;
  const cursor = `${sortTag(sort)}${CURSOR_SEP}${payload}${CURSOR_SEP}${key}`;
  if (cursor.length > B.cursorChars) {
    // Unreachable by the arithmetic above; refuse to issue rather than hand out
    // a cursor the next request would reject.
    throw new Error('doc-store: cursor exceeds its own bound');
  }
  return cursor;
}

function decodeCursor(sort: SortSpec, cursor: string): { value: string; key: string } {
  const bad = () => invalid('invalid cursor');
  if (typeof cursor !== 'string' || cursor.length > B.cursorChars) throw bad();
  const first = cursor.indexOf(CURSOR_SEP);
  const last = cursor.lastIndexOf(CURSOR_SEP);
  if (first < 0 || last === first) throw bad();
  const head = cursor.slice(0, first);
  const payload = cursor.slice(first + 1, last);
  const key = cursor.slice(last + 1);
  if (head !== sortTag(sort)) throw bad();
  if (!B.key.test(key)) throw bad();
  let value = payload;
  if (sort.kind === 'index' && sort.type === 'string') {
    if (!/^[A-Za-z0-9_-]*$/.test(payload)) throw bad();
    value = Buffer.from(payload, 'base64url').toString('utf8');
  } else if (sort.kind === 'index') {
    // float8 text, as Postgres printed it.
    if (!/^-?[0-9.eE+-]{1,32}$/.test(payload) || !Number.isFinite(Number(payload))) throw bad();
  } else if (sort.kind !== 'key') {
    // Microseconds since epoch (17 digits reach year 5138). Anything else would be a 500
    // from the cast or the interval arithmetic.
    if (!/^[0-9]{1,17}$/.test(payload)) throw bad();
  }
  return { value, key };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type UsageDelta = { bytes: number; docs: number };
type UserCharge = UsageDelta & { uid: number; ceiling: QuotaCeiling };

/** The app-ceiling charge of a write that moves no shared bytes: it still takes the next seq. */
const NO_APP_CHARGE: UsageDelta = { bytes: 0, docs: 0 };

/**
 * What a document change costs the APP's ceiling, by the key space it lives in (see WHICH
 * CEILINGS in the module header): the whole delta for a shared document (`scope_uid = 0`),
 * nothing for a private one. The single place that decides it.
 */
function appDelta(scope: number, delta: UsageDelta): UsageDelta {
  return scope === 0 ? delta : NO_APP_CHARGE;
}

export type DocStore = ReturnType<typeof createDocStore>;
export type DocStoreModeration = ReturnType<typeof createDocStoreModeration>;

/** The store the block-token routes use. It carries no moderator operation. */
export function createDocStore(deps: DocStoreDeps) {
  return buildDocStore(deps).store;
}

/**
 * The session-moderator operations, as a SEPARATE object from the viewer store, so holding
 * the block-token API's store gives no path to them. Only `doc-store-moderation.instance.ts`
 * builds one in production; its importers are pinned by a ledger test.
 */
export function createDocStoreModeration(deps: DocStoreDeps) {
  return buildDocStore(deps).moderation;
}

/**
 * THE RATER (content levels): list the shared documents that need a rating and record one, as a
 * SEPARATE object from the viewer store, so holding the block-token routes' store gives no path to
 * writing a rating. Only `doc-store-rater.instance.ts` builds one in production.
 */
export function createDocStoreRater(deps: DocStoreDeps) {
  return buildDocStore(deps).rater;
}
export type DocStoreRater = ReturnType<typeof createDocStoreRater>;

/**
 * MAINTENANCE — review-namespace deletion (`purgeReview`, `listReviewAppIds`), account deletion
 * (`wipeAccount`) and app deletion (`purgeApp`) — as a separate object from the viewer store: the
 * first runs with the setting that reaches every `rev:` row of a request, the second with the one
 * that reads one user's rows in every app, the third with the one that reads one app's rows in
 * every namespace, so nothing holding the block-token routes' store may reach any of them.
 * Only `doc-store-maintenance.instance.ts` builds one in production; its importers are pinned by
 * a ledger test (`__tests__/doc-store-maintenance.ledger.test.ts`).
 */
export function createDocStoreMaintenance(deps: DocStoreDeps) {
  return buildDocStore(deps).maintenance;
}
export type DocStoreMaintenance = ReturnType<typeof createDocStoreMaintenance>;

/**
 * SERVER LOOKUP — resolve an app-supplied shared key to its document's author and hidden state,
 * for server code that checks a published item (App Store sub-listings, spend attribution).
 */
export function createDocStoreLookup(deps: DocStoreDeps) {
  return buildDocStore(deps).lookup;
}
export type DocStoreLookup = ReturnType<typeof createDocStoreLookup>;

/**
 * REGISTRY FEED — the shared documents of one app's production namespace, by seq, read only, for
 * the registry adapter. Private documents and every other namespace are out of its reach: each
 * statement fixes `scope_uid = 0`, and the context fixes the production namespace.
 */
export function createDocStoreFeed(deps: DocStoreDeps) {
  return buildDocStore(deps).feed;
}
export type DocStoreFeed = ReturnType<typeof createDocStoreFeed>;

/**
 * PRIVATE FEED — ONE user's private documents of one collection of an app's production namespace,
 * read only, for the registry adapter's authorized private streams (`private-feed.ts`). It never
 * decides who may read: its caller passes the user only after the one collection-read predicate
 * (`data-read-grant.ts`) granted that user the collection. A separate object, so neither the
 * public feed nor the block-token store carries a read keyed on a caller-supplied user id; its
 * importers are pinned by `__tests__/doc-store-private-feed.ledger.test.ts`. `privateHead` reads
 * the namespace's write head (`SQL_FEED_HEAD`), which a stream reads before its keyset.
 */
export function createDocStorePrivateFeed(deps: DocStoreDeps) {
  return buildDocStore(deps).privateFeed;
}
export type DocStorePrivateFeed = ReturnType<typeof createDocStorePrivateFeed>;

/**
 * One private document's identity, version and `seq` (where its last write sits in the app
 * namespace's write order, `usage_app.last_seq` when it was written), as `privateVersions` reads it.
 */
export type PrivateFeedVersion = { key: string; recordId: string; version: number; seq: number };
/** One private document, as `privateDocuments` reads it. */
export type PrivateFeedDocument = PrivateFeedVersion & { data: Record<string, unknown> };

/** Most rows one feed page may ask for. */
export const FEED_MAX_PAGE = 1000;

/** A shared document as the feed reads it. */
export type FeedDocument = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
};

/** One page of `feedChanges`. */
export type FeedChangesPage = {
  docs: Array<FeedDocument & { hidden: boolean }>;
  tombs: Array<{ key: string; seq: number }>;
};

/**
 * Which documents of a shared collection one level stream carries (`registry-adapter/level-feed.ts`):
 * those rated at exactly one selectable level bit, or every visible document (content levels off).
 */
export type LevelSelector = { bit: number } | 'none';

/**
 * A shared document as a level stream carries it: a plain document (`docs/app-storage-generic-core.md`,
 * "Registry and app-data-go impact"). Never its author, any tally, or anyone's marks.
 */
export type LevelStreamDocument = {
  key: string;
  data: Record<string, unknown>;
  version: number;
  seq: number;
  createdAt: string;
  updatedAt: string;
};

/** One page of `levelChanges`: each row flagged whether it is on the stream now. */
export type LevelChangesPage = {
  docs: Array<LevelStreamDocument & { onStream: boolean }>;
  tombs: Array<{ key: string; seq: number }>;
};

/**
 * VIEWER DATA — a signed-in user's own production data across apps, for their account settings:
 * the apps they hold documents in (`listViewerUsage`), what an empty would do with each app's
 * figure (`viewerHoldings`) and emptying one of them (`emptyViewerData`). A separate object because the listing reads one user's usage rows in
 * every app (the account-wipe enumeration's setting), which nothing holding the block-token
 * routes' store may reach. The caller passes the SESSION user's id, never request input. Only
 * `doc-store-viewer-data.instance.ts` builds one in production; its importers are pinned by
 * `__tests__/doc-store-viewer-data.ledger.test.ts`.
 */
export function createDocStoreViewerData(deps: DocStoreDeps) {
  return buildDocStore(deps).viewerData;
}
export type DocStoreViewerData = ReturnType<typeof createDocStoreViewerData>;

/** One app's stored production usage for one user (`listViewerUsage`). */
export type ViewerAppUsage = { appId: string; bytes: number; docs: number };

/**
 * One user's figure in one app (`viewerHoldings`), split by what `emptyViewerData` does with it:
 * `private` always goes, `shared` (visible posts they authored) goes when asked for, `hidden`
 * (their posts moderation hid) stays.
 */
export type ViewerAppHoldings = StorageHoldings;

/** What `emptyViewerData` deleted. */
export type ViewerDataEmptyResult = {
  privateDocs: number;
  privateBytes: number;
  /** Zero unless the shared documents were asked for. */
  sharedDocs: number;
  sharedBytes: number;
};

/** Where a page of `viewerRecords` ends: the last (collection, key space, key) it read. */
export type ViewerRecordCursor = { coll: string; scopeUid: number; key: string };

/**
 * One document a user owns, as `viewerRecords` reads it: the record core's source row
 * (`RecordSourceRow` in `app-record.ts`) with its collection.
 */
export type ViewerRecordRow = {
  coll: string;
  scopeUid: number;
  key: string;
  data: Record<string, unknown>;
  version: number;
  author: DocAuthor;
  lastWriterUid: number | null;
  recordId: string | null;
};

/** Where a schema migration's page of documents ends: the last (key space, key) it read. */
export type MigrationCursor = { scopeUid: number; key: string };

/** Failures sampled per page by `migrateDocuments` (the count is always exact). */
const MIGRATION_FAILURE_SAMPLES = 5;

/** What one `migrateDocuments` page did. */
export type MigrateDocumentsResult = {
  /** Documents read under lock (one deleted between the page read and its lock is not counted). */
  scanned: number;
  /** Rewritten by the transform. */
  migrated: number;
  /** The transform changed nothing. */
  unchanged: number;
  /** The rewrite was refused (size cap, index value, quota) and the document left as it was. */
  failed: number;
  /** Changed or not, still not matching the collection's schema afterwards. */
  invalid: number;
  /** Up to {@link MIGRATION_FAILURE_SAMPLES} failed documents, with the refusal's code. */
  failures: { scopeUid: number; key: string; code: string }[];
  /** The cursor of the next page, or null when there is none. */
  next: MigrationCursor | null;
};

/** One maintenance run (`appdata.maint_run`): a mark migration or a per-collection purge. */
export type MaintRun = {
  collection: string;
  kind: 'mark_migration' | 'purge' | 'purge_dump';
  /** The mark name (`mark_migration`), the run id (`purge`) or `<run id>.<batch>` (`purge_dump`). */
  name: string;
  /**
   * `frozen`, `copied`, `verified`, `mismatch` or `rolled_back`; a purge `purging`, `purged` or
   * `abandoned` (left unfinished past the retention period).
   */
  status: string;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  /** The moderator who started (or last advanced) it. */
  actorUid: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Every row a per-collection purge deleted, as it was. */
export type PurgeDump = {
  docs: {
    key: string;
    data: unknown;
    version: number;
    seq: number;
    sizeBytes: number;
    authorUid: number | null;
    authorKind: string;
    lastWriterUid: number | null;
    createdAt: string;
    updatedAt: string;
    hiddenAt: string | null;
    hiddenBy: number | null;
    reportsDismissedAt: string | null;
  }[];
  index: { key: string; name: string; type: string; text: string | null; num: number | null }[];
  tallies: { key: string; kind: string; name: string; count: number }[];
  marks: { key: string; name: string; userId: number; reason: string | null; createdAt: string }[];
};

/** Days a finished purge's dumps are kept (`expireMaintDumps`). */
export const PURGE_DUMP_RETENTION_DAYS = 30;

/** The production namespace: published data, never a developer's dev or a moderator's review namespace. */
export const PUBLISHED_NS = 'prod';

/** Postgres `undefined_column`: what a statement naming `schema_major` gets before the migration. */
const PG_UNDEFINED_COLUMN = '42703';
/** How long a store trusts "no `schema_major` column" before probing again. */
const SCHEMA_MAJOR_RECHECK_MS = 60_000;
/** undefined_table: an optional table does not exist (its migration is not applied). */
const PG_UNDEFINED_TABLE = '42P01';
/**
 * Zero: a store never trusts "`appdata.maint_run` is absent" (only presence is kept). The freeze is
 * read on every mark, and a remembered absence would let marks through after the table and a
 * freeze appeared, which the copy would then miss.
 */
const MAINT_RUN_RECHECK_MS = 0;
/** The manual migration that adds `appdata.maint_run`. */
export const MAINT_RUN_MIGRATION = '20261123120000_appdata_maint_run.sql';

/** One shared document matched by `findSharedByKey`. */
export type SharedKeyMatch = {
  collection: string;
  /** Null for a document no user authored (an `app` or `counter` document). */
  authorUid: number | null;
  /** A moderator hide. Never a level: the lookup is level-blind. */
  hidden: boolean;
  /** Asked for (`{ rating: true }`, content levels on) only. */
  rating?: DocRating;
};

/**
 * A relation (a table or a column) that a manual migration adds, which the store uses only once it
 * exists, without a restart: the one probe `schema_major` and the mark sequence share. Found once
 * and kept; while absent, tried again at most every `recheckMs`. `codes` are the SQLSTATEs that
 * mean it is missing (42P01 undefined_table, 42703 undefined_column).
 */
function optionalRelationProbe(name: string, codes: readonly string[], recheckMs: number) {
  let state: { present: boolean; at: number } | undefined;
  const savepoint = `${name}_probe`;
  const isMissing = (err: unknown) => codes.includes((err as { code?: string } | null)?.code ?? '');
  return {
    /** Known present, with no query: a statement naming it may run as is. */
    get present(): boolean {
      return state?.present === true;
    },
    /**
     * After a statement naming it failed while it was known present: a missing-relation failure
     * (it was dropped since, a rollback of the migration) forgets it, so the next call looks
     * again. The failing call itself still fails.
     */
    forgetIfMissing(err: unknown): void {
      if (isMissing(err)) state = undefined;
    },
    /**
     * Run `fn`, which names the relation, only where it exists; null where it does not. Known
     * present: run as is (a missing-relation failure forgets it, and is thrown). Known absent
     * within `recheckMs`: null, with no query. Otherwise under a savepoint: a missing-relation
     * failure rolls back to it, the transaction goes on, and the answer is null. Any other failure
     * is the transaction's own and is thrown.
     */
    async run<T>(c: DocStoreClient, fn: () => Promise<T>): Promise<T | null> {
      if (state?.present) {
        try {
          return await fn();
        } catch (err) {
          if (isMissing(err)) state = undefined;
          throw err;
        }
      }
      if (state && Date.now() - state.at < recheckMs) return null;
      await c.query(`SAVEPOINT ${savepoint}`);
      try {
        const out = await fn();
        await c.query(`RELEASE SAVEPOINT ${savepoint}`);
        state = { present: true, at: Date.now() };
        return out;
      } catch (err) {
        if (!isMissing(err)) throw err;
        await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        state = { present: false, at: Date.now() };
        return null;
      }
    },
  };
}

function buildDocStore(deps: DocStoreDeps) {
  const limits = deps.limits ?? DEFAULT_DOC_STORE_LIMITS;
  // Settled only by a successful role read; a failed read is retried next call.
  let privileges: 'safe' | 'refused' | undefined;
  // `appdata.doc.schema_major` (a manual migration): stamped only once it exists.
  const schemaMajorColumn = optionalRelationProbe(
    'schema_major',
    [PG_UNDEFINED_COLUMN],
    SCHEMA_MAJOR_RECHECK_MS
  );
  // `appdata.maint_run` (a manual migration): marks are frozen and maintenance runs recorded only
  // once it exists.
  const maintRunTable = optionalRelationProbe(
    'maint_run',
    [PG_UNDEFINED_TABLE],
    MAINT_RUN_RECHECK_MS
  );
  /** Run `fn`, which names `appdata.maint_run`, only where it exists; null where it does not. */
  const withMaintRun = <T>(c: DocStoreClient, fn: () => Promise<T>) => maintRunTable.run(c, fn);

  /** One statement of a purge or wipe; the `maint_run` one only where its table exists. */
  async function purgeRows(c: DocStoreClient, sql: string, params: unknown[]): Promise<number> {
    const run = async () => Number((await c.query(sql, params)).rows[0]?.n ?? 0);
    if (/appdata\.maint_run\b/.test(sql)) return (await withMaintRun(c, run)) ?? 0;
    return run();
  }

  /**
   * Whether this write can stamp `schema_major`. Probed inside the write's own transaction under
   * a savepoint: a missing column (42703) rolls back to the savepoint and the write goes on
   * without the stamp. Any other failure is the transaction's own and is thrown as it is.
   */
  async function hasSchemaMajorColumn(c: DocStoreClient, ctx: DocStoreContext): Promise<boolean> {
    if (schemaMajorColumn.present) return true;
    const found = await schemaMajorColumn.run(c, async () => {
      await c.query(SQL_SCHEMA_MAJOR_PROBE, [ctx.appId, ctx.ns]);
      return true;
    });
    return found === true;
  }

  /**
   * Stamp the seq of a document whose body this transaction just wrote, and return it. With
   * `coll.schemaMajor` given and the column present, also stamp the major the body was written
   * under. Every write of a document body ends here (`finishWrite`, `migrateDocuments`), and
   * nothing else does.
   */
  async function stampWrittenDoc(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    scope: number,
    key: string,
    seq: number
  ): Promise<DocStoreQueryResult> {
    const base = [ctx.appId, ctx.ns, coll.name, scope, key, seq];
    if (coll.schemaMajor === undefined || !(await hasSchemaMajorColumn(c, ctx))) {
      return c.query(ctx.levels ? SQL_STAMP_SEQ_LEVELS : SQL_STAMP_SEQ, base);
    }
    try {
      return await c.query(ctx.levels ? SQL_STAMP_SEQ_MAJOR_LEVELS : SQL_STAMP_SEQ_MAJOR, [
        ...base,
        coll.schemaMajor,
      ]);
    } catch (err) {
      // The column was dropped after it was found (a rollback of the migration): look again on
      // the next write. This write fails; the next one writes without the stamp.
      schemaMajorColumn.forgetIfMissing(err);
      throw err;
    }
  }

  /**
   * Refuse to run on a role row-level security does not bind. Checked on the
   * first connection this store opens (the pool's role is fixed), then cached.
   */
  async function assertLeastPrivilege(c: DocStoreClient): Promise<void> {
    if (privileges === undefined) {
      const row = (await c.query(SQL_ROLE_PRIVILEGES)).rows[0];
      const superuser = row?.rolsuper === true;
      const bypassRls = row?.rolbypassrls === true;
      // A role pg_roles cannot describe is not one we can vouch for.
      const unsafe = !row || superuser || bypassRls;
      if (privileges === undefined) {
        privileges = unsafe ? 'refused' : 'safe';
        if (unsafe) deps.onRefused?.({ name: String(row?.rolname ?? ''), superuser, bypassRls });
      }
    }
    if (privileges === 'refused') {
      throw new DocStoreError(
        'storage_disabled',
        'document storage is disabled: its database role bypasses row-level security'
      );
    }
  }

  /**
   * Run `fn` in one transaction with the RLS settings bound. `set_config(…, true)`
   * is `SET LOCAL`: the settings end with the transaction, so a pooled
   * connection can never carry one app's identity into the next checkout. The
   * values are validated by `assertContext` and then quoted, because the
   * settings ride in the same simple-protocol round trip as `BEGIN`.
   */
  async function withTx<T>(
    ctx: DocStoreContext,
    fn: (c: DocStoreClient) => Promise<T>
  ): Promise<T> {
    assertContext(ctx);
    return runTx(
      `BEGIN; SELECT set_config('appdata.app_id', ${escapeLiteral(
        ctx.appId
      )}, true), set_config('appdata.ns', ${escapeLiteral(
        ctx.ns
      )}, true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`,
      fn
    );
  }

  /**
   * A REVIEW MAINTENANCE transaction: no namespace bound, `appdata.review_maintenance` on —
   * which the migration's review policies admit for `rev:` rows only, read and delete only —
   * and `appdata.app_id` bound to `publishRequestId` (the only app whose rows a delete reaches),
   * or to nothing when listing. Transaction-local like every other setting. 🔴 Called by
   * `purgeReview` and `listReviewAppIds` ONLY (pinned by `doc-store.sql-isolation.test.ts`).
   */
  async function maintenanceTx<T>(
    publishRequestId: string | null,
    fn: (c: DocStoreClient) => Promise<T>
  ): Promise<T> {
    if (publishRequestId !== null && !APP_ID_SHAPE.test(publishRequestId)) {
      throw new Error('doc-store: malformed publish request id');
    }
    return runTx(
      `BEGIN; SELECT set_config('appdata.app_id', ${escapeLiteral(
        publishRequestId ?? ''
      )}, true), set_config('appdata.ns', '', true), set_config('appdata.review_maintenance', 'on', true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`,
      fn
    );
  }

  /**
   * An ACCOUNT-WIPE ENUMERATION transaction: no app or namespace bound, and
   * `appdata.account_wipe_uid` set to one validated user id — which the migration's wipe policy
   * admits for that user's `usage_user` and `doc_mark` rows only, read only. Transaction-local like
   * every other setting. 🔴 Called by `listAccountNamespaces` and `listViewerUsage` ONLY (pinned
   * by `doc-store.sql-isolation.test.ts`).
   */
  async function accountWipeTx<T>(
    userId: number,
    fn: (c: DocStoreClient) => Promise<T>
  ): Promise<T> {
    assertWipeUserId(userId);
    return runTx(
      `BEGIN; SELECT set_config('appdata.app_id', '', true), set_config('appdata.ns', '', true), set_config('appdata.account_wipe_uid', '${userId}', true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`,
      fn
    );
  }

  /**
   * An APP-PURGE ENUMERATION transaction: no app or namespace bound, and `appdata.app_purge_id`
   * set to one validated app id — which the app-purge migration's policy admits for that app's
   * `doc` and `usage_app` rows only, read only. Transaction-local like every other setting.
   * 🔴 Called by `listAppNamespaces` ONLY (pinned by `doc-store.sql-isolation.test.ts`).
   */
  async function appPurgeTx<T>(appId: string, fn: (c: DocStoreClient) => Promise<T>): Promise<T> {
    if (!APP_ID_SHAPE.test(appId)) throw new Error('doc-store: malformed app id');
    return runTx(
      `BEGIN; SELECT set_config('appdata.app_id', '', true), set_config('appdata.ns', '', true), set_config('appdata.app_purge_id', ${escapeLiteral(
        appId
      )}, true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`,
      fn
    );
  }

  /**
   * A RATER LOOKUP transaction: no app or namespace bound, and `appdata.rater_lookup_id` set to one
   * validated rating id — which the rating-id migration's policy admits for the ONE shared `doc`
   * row carrying it, read only. Transaction-local like every other setting. 🔴 Called by the
   * rater's `findByRatingId` and `ready` ONLY (pinned by `doc-store.sql-isolation.test.ts`).
   */
  async function raterLookupTx<T>(
    ratingId: number,
    fn: (c: DocStoreClient) => Promise<T>
  ): Promise<T> {
    if (!Number.isSafeInteger(ratingId) || ratingId < 0 || ratingId > 2_147_483_647) {
      throw new Error('doc-store: malformed rating id');
    }
    return runTx(
      `BEGIN; SELECT set_config('appdata.app_id', '', true), set_config('appdata.ns', '', true), set_config('appdata.rater_lookup_id', '${ratingId}', true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`,
      fn
    );
  }

  /**
   * Whether this store can serve calls: it has a connection and its role passed the
   * least-privilege check — the SAME two refusals every call makes (`runTx`), so this cannot
   * disagree with them. Reads the role at most until it is settled (one round trip on a cold
   * store, none after). Throws when the role cannot be read (the connection failed); the caller
   * decides what an unconfirmed store reads as. Backs `civitai_app_block_doc_store_enabled`.
   */
  async function isUsable(): Promise<boolean> {
    if (!deps.db) return false;
    if (privileges === undefined) {
      const client = await deps.db.connect();
      try {
        await assertLeastPrivilege(client);
      } catch (err) {
        if (!(err instanceof DocStoreError && err.code === 'storage_disabled')) throw err;
      } finally {
        client.release();
      }
    }
    return privileges === 'safe';
  }

  async function runTx<T>(begin: string, fn: (c: DocStoreClient) => Promise<T>): Promise<T> {
    if (!deps.db) {
      throw new DocStoreError('storage_disabled', 'document storage is not configured');
    }
    let client: DocStoreClient;
    try {
      client = await deps.db.connect();
    } catch (err) {
      // An outage (the pool's connection timeout, a refused or dropped socket, too many
      // connections, a server restarting) is retryable; misconfiguration is not.
      throw isPgConnectionFault(err) ? connectionUnavailable(err) : connectConfigFault(err);
    }
    let broken = false;
    try {
      await assertLeastPrivilege(client);
    } catch (err) {
      client.release();
      throw translatePgError(err);
    }
    let committing = false;
    try {
      await client.query(begin);
      const out = await fn(client);
      committing = true;
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      // A connection lost ON COMMIT has an unknown outcome — the write may have landed — so it
      // is not translated into a retry invitation (create/increment are not idempotent).
      throw translatePgError(err, { outcomeUnknown: committing });
    } finally {
      client.release(broken);
    }
  }

  /**
   * The per-user ceiling of `uid`: `deps.userLimits` (production: their membership tier's), else
   * the store-wide `limits`. The one rule the write charge and the `info` figures both apply.
   */
  async function viewerLimits(uid: number): Promise<{ userBytes: number; userDocs: number }> {
    if (deps.userLimits) return deps.userLimits(uid);
    return { userBytes: limits.userBytes, userDocs: limits.userDocs };
  }

  /**
   * The per-user ceilings a write will charge against, resolved BEFORE its transaction opens
   * (`resolveCeilings`), so the charge never waits on the resolver while holding the app's
   * usage-row lock that `SQL_CHARGE_APP` takes: the viewer's for a put or an increment, every
   * owner on the page for a migration. Keyed on the call's context; set at the start of each call.
   */
  const preResolvedCeilings = new WeakMap<
    DocStoreContext,
    Map<number, { userBytes: number; userDocs: number }>
  >();

  /** How many users' ceilings `resolveCeilings` looks up at once. */
  const CEILING_LOOKUP_CONCURRENCY = 10;

  async function resolveCeilings(ctx: DocStoreContext, uids: Iterable<number>): Promise<void> {
    if (!deps.userLimits) return;
    const resolved = new Map<number, { userBytes: number; userDocs: number }>();
    // A migration page can name up to 1,000 owners: look their tiers up a bounded few at a time.
    await limitConcurrency(
      [...new Set(uids)].map((uid) => async () => {
        resolved.set(uid, await viewerLimits(uid));
      }),
      CEILING_LOOKUP_CONCURRENCY
    );
    preResolvedCeilings.set(ctx, resolved);
  }

  /**
   * Charge one write: `usage_app` (which also yields the seq), then the caller's `usage_user`.
   * `seqs` > 1 charges a transaction that changed that many documents: the returned seq is the
   * LAST of `seqs` consecutive ones.
   */
  async function charge(
    c: DocStoreClient,
    ctx: DocStoreContext,
    app: UsageDelta,
    user: UserCharge,
    seqs = 1
  ): Promise<number> {
    await deps.hooks?.beforeUsageCharge?.();
    const appArgs = [ctx.appId, ctx.ns, app.bytes, app.docs, limits.appBytes, limits.appDocs];
    const appRes =
      seqs === 1
        ? await c.query(SQL_CHARGE_APP, appArgs)
        : await c.query(SQL_CHARGE_APP_SEQS, [...appArgs, seqs]);
    if (appRes.rows.length === 0) {
      throw new DocStoreError('quota_exceeded', 'app storage quota exceeded', { ceiling: 'app' });
    }
    if (user.bytes !== 0 || user.docs !== 0) {
      // A charge that only frees passes whatever the ceiling (SQL_CHARGE_USER), so it reads none.
      // Every charge that adds bytes or documents is to a user resolved before the transaction:
      // the viewer (put, create) or, for a migration, the owners on the page — the only
      // charge to someone other than the caller. The lookup here, under the lock, is a fallback
      // no call path reaches; it keeps a missed pre-resolution correct, only slower.
      const ceiling = !(user.bytes > 0 || user.docs > 0)
        ? limits
        : preResolvedCeilings.get(ctx)?.get(user.uid) ?? (await viewerLimits(user.uid));
      const res = await c.query(SQL_CHARGE_USER, [
        ctx.appId,
        ctx.ns,
        user.uid,
        user.bytes,
        user.docs,
        ceiling.userBytes,
        ceiling.userDocs,
      ]);
      if (res.rows.length === 0) {
        throw new DocStoreError('quota_exceeded', 'storage quota exceeded', {
          ceiling: user.ceiling,
        });
      }
    }
    return Number(appRes.rows[0].last_seq);
  }

  /** Private docs are the viewer's own; a shared doc's per-user ceiling is its author's. */
  const ceilingFor = (coll: DocCollection): QuotaCeiling =>
    coll.config.visibility === 'private' ? 'viewer' : 'author';

  /** Under `own`, only the user who authored a shared doc changes or deletes it. */
  function assertMayModify(
    ctx: DocStoreContext,
    coll: DocCollection,
    row: Record<string, unknown>
  ) {
    if (coll.config.visibility !== 'shared') return;
    const isAuthor = row.author_kind === 'user' && Number(row.author_uid) === ctx.viewerUid;
    if (!isAuthor) {
      throw new DocStoreError('not_author', 'only the author may change this document');
    }
  }

  async function writeDoc(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    data: unknown,
    opts: { ifVersion?: number; op: 'create' | 'put'; hookPass?: HookPass }
  ): Promise<WrittenDocRecord> {
    const policy = assertCollection(coll);
    assertKey(key);
    const viewer = requireViewer(ctx);
    assertShareWritable(coll, policy);
    if (
      opts.ifVersion !== undefined &&
      !(Number.isSafeInteger(opts.ifVersion) && opts.ifVersion >= 0)
    ) {
      throw invalid('ifVersion must be a non-negative integer');
    }
    const json = serializeData(data);
    // Here, not only in the REST layer, so that every write of a document body is checked
    // whoever calls the store. `data` is the whole body the row will hold.
    validateDocAgainstCollectionSchema(ctx, coll, data);
    // After every check of the body, so a malformed write never spends a pass.
    const ifVersion = effectiveIfVersion(
      opts.ifVersion,
      requireHookPass(ctx, coll, opts.op, key, opts.hookPass)
    );
    const indexRows = indexRowsFor(coll, data as Record<string, unknown>);
    const scope = scopeUid(ctx, coll);
    const base = [ctx.appId, ctx.ns, coll.name, scope, key];
    await resolveCeilings(ctx, [viewer]);

    return withTx(ctx, async (c) => {
      // Two passes at most: a concurrent creator of the same key can win the
      // INSERT between our lock read and our insert; the second pass then sees
      // (and locks) its row.
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = (await c.query(SQL_LOCK_DOC, base)).rows[0];
        if (existing) {
          // See VISIBLE: refusing a write to a hidden key reveals that it exists.
          if (existing.hidden) throw new DocStoreError('not_found', 'document not found');
          const current = Number(existing.version);
          if (ifVersion !== undefined && ifVersion !== current) {
            throw new DocStoreError('version_conflict', 'version conflict', {
              currentVersion: current,
            });
          }
          assertMayModify(ctx, coll, existing);
          const res = await c.query(SQL_UPDATE_DOC, [...base, json, viewer]);
          await markRatingPending(c, ctx, coll, key);
          const delta = Number(res.rows[0].size_bytes) - Number(existing.size_bytes);
          return finishWrite(c, ctx, coll, scope, key, indexRows, {
            app: appDelta(scope, { bytes: delta, docs: 0 }),
            user: { uid: viewer, bytes: delta, docs: 0, ceiling: ceilingFor(coll) },
          });
        }

        if (ifVersion !== undefined && ifVersion !== 0) {
          throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: 0 });
        }
        const ins = await c.query(SQL_INSERT_DOC, [...base, json, viewer]);
        if (ins.rows.length === 0) continue; // lost the race; re-read
        await markRatingPending(c, ctx, coll, key);
        const size = Number(ins.rows[0].size_bytes);
        return finishWrite(c, ctx, coll, scope, key, indexRows, {
          app: appDelta(scope, { bytes: size, docs: 1 }),
          user: { uid: viewer, bytes: size, docs: 1, ceiling: ceilingFor(coll) },
        });
      }
      throw new DocStoreError('version_conflict', 'concurrent write; retry', {
        currentVersion: null,
      });
    });
  }

  /**
   * While levels are on, a shared document whose body this transaction just wrote waits to be
   * rated again (`SQL_RATING_PENDING`). Off, or a private collection, it sends nothing.
   */
  async function markRatingPending(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string
  ): Promise<void> {
    if (!ctx.levels || coll.config.visibility !== 'shared') return;
    await c.query(SQL_RATING_PENDING, [ctx.appId, ctx.ns, coll.name, key]);
  }

  async function finishWrite(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    scope: number,
    key: string,
    indexRows: IndexRow[],
    usage: { app: UsageDelta; user: UserCharge }
  ): Promise<WrittenDocRecord> {
    // Always, even with no index declared: it then deletes every index row the
    // document has, so an index declared, dropped and declared again never
    // serves values from before it was dropped.
    await c.query(SQL_SYNC_INDEX, [
      ctx.appId,
      ctx.ns,
      coll.name,
      scope,
      key,
      indexRows.map((r) => r.name),
      indexRows.map((r) => r.vText),
      indexRows.map((r) => r.vNum),
      indexRows.map((r) => r.type),
    ]);
    const seq = await charge(c, ctx, usage.app, usage.user);
    const res = await stampWrittenDoc(c, ctx, coll, scope, key, seq);
    return toWrittenDocRecord(res.rows[0], ctx);
  }

  async function getMany(
    ctx: DocStoreContext,
    coll: DocCollection,
    keys: string[]
  ): Promise<(DocRecord | null)[]> {
    assertCollection(coll);
    if (!Array.isArray(keys) || keys.length > B.getManyMax) {
      throw invalid(`getMany takes at most ${B.getManyMax} keys`);
    }
    keys.forEach(assertKey);
    if (keys.length === 0) return [];
    const scope = scopeUid(ctx, coll);
    const base = [ctx.appId, ctx.ns, coll.name, scope];
    const unique = [...new Set(keys)];
    const rows = await withTx(
      ctx,
      async (c) =>
        (ctx.levels
          ? await c.query(SQL_GET_MANY_LEVELS, [
              ...base,
              ctx.viewerUid,
              unique,
              ctx.levels.viewerLevel,
              ctx.levels.domainLevel ?? ctx.levels.viewerLevel,
            ])
          : await c.query(SQL_GET_MANY, [...base, unique])
        ).rows
    );
    const byKey = new Map(rows.map((r) => [r.key as string, toDocRecord(r, ctx)]));
    return keys.map((k) => byKey.get(k) ?? null);
  }

  async function get(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string
  ): Promise<DocRecord | null> {
    return (await getMany(ctx, coll, [key]))[0];
  }

  async function put(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    data: Record<string, unknown>,
    opts: { ifVersion?: number; hookPass?: HookPass } = {}
  ): Promise<WrittenDocRecord> {
    return writeDoc(ctx, coll, key, data, { ...opts, op: 'put' });
  }

  /**
   * Create a document under a new key: `opts.key` when the caller generated it (the permission
   * hook is shown the key before the write), else a fresh ULID. Never overwrites: the write is
   * pinned to "no document" (`ifVersion: 0`) either way.
   */
  async function create(
    ctx: DocStoreContext,
    coll: DocCollection,
    data: Record<string, unknown>,
    opts: { key?: string; hookPass?: HookPass } = {}
  ): Promise<WrittenDocRecord> {
    return writeDoc(ctx, coll, opts.key ?? newUlid(), data, {
      ifVersion: 0,
      op: 'create',
      hookPass: opts.hookPass,
    });
  }

  /**
   * A shared `put` that would change no stored row, answered without writing: the stored document
   * with its current seq and record id, untouched (no version, seq or `updated_at` bump, no index
   * sync, no usage charge, no `markRatingPending`, so a rating given for its version stands), when
   * ALL of:
   * - a document is stored at `key` and `classifyPublish` calls it `unchanged` against `data` —
   *   the ONE rule a publish uses: the caller's own, not hidden, and the same content hash;
   * - its stored index rows are exactly the rows `indexRowsFor` derives from `data` under the
   *   collection's CURRENT declaration (an index declared or dropped since, or a value the
   *   declaration now refuses, is a write that would change or refuse something);
   * - `opts.ifVersion`, when given, is its current version.
   * Otherwise `null`, having written nothing; the caller then makes the ordinary write, which
   * refuses (or writes) exactly as it always did. So a stale `ifVersion`, someone else's or a hidden
   * document, an absent key, a private collection and a body the store would refuse are all
   * `null`, never a refusal of their own. A collection with a permission hook is always `null`.
   *
   * ONE unlocked read (SQL_UNCHANGED_PROBE), no lock: nothing is written on its answer, so a
   * concurrent write is simply before or after it, and a body that differs from what the read saw
   * always goes to the ordinary write. Not refreshed here: the schema-major stamp
   * (`coll.schemaMajor`), which an ordinary write would re-stamp; revisit if a read path starts
   * migrating bodies on serve.
   */
  async function putIfUnchanged(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    data: Record<string, unknown>,
    opts: { ifVersion?: number } = {}
  ): Promise<WrittenDocRecord | null> {
    const policy = assertCollection(coll);
    const viewer = requireViewer(ctx);
    assertShareWritable(coll, policy);
    if (coll.config.visibility !== 'shared') return null;
    // A collection with a permission hook: every put is the hook's to decide, unchanged or not, so
    // it always takes the ordinary (hooked) write. Answering here would return 200 for a put the
    // hook refuses.
    if (coll.config.hook) return null;
    let json: string;
    let indexRows: IndexRow[];
    try {
      assertKey(key);
      json = serializeData(data);
      indexRows = indexRowsFor(coll, data);
    } catch {
      // `writeDoc` refuses it, after the caller's budget and scan, as it always has.
      return null;
    }
    const row = await withTx(
      ctx,
      async (c) =>
        (
          await c.query(ctx.levels ? SQL_UNCHANGED_PROBE_LEVELS : SQL_UNCHANGED_PROBE, [
            ctx.appId,
            ctx.ns,
            coll.name,
            0,
            key,
            json,
            indexRows.map((r) => r.name),
            indexRows.map((r) => r.vText),
            indexRows.map((r) => r.vNum),
            indexRows.map((r) => r.type),
          ])
        ).rows[0]
    );
    if (!row) return null;
    if (classifyPublish(viewer, { hash: String(row.written_hash) }, row) !== 'unchanged') {
      return null;
    }
    if (row.index_same !== true) return null;
    if (opts.ifVersion !== undefined && opts.ifVersion !== Number(row.version)) return null;
    return toWrittenDocRecord(row, ctx);
  }

  async function remove(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    opts: { ifVersion?: number; hookPass?: HookPass } = {}
  ): Promise<DocDeleteResult> {
    const policy = assertCollection(coll);
    assertKey(key);
    const viewer = requireViewer(ctx);
    assertShareWritable(coll, policy);
    const scope = scopeUid(ctx, coll);
    const ifVersion = effectiveIfVersion(
      opts.ifVersion,
      requireHookPass(ctx, coll, 'delete', key, opts.hookPass)
    );
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, scope, key])).rows[0];
      // Missing and hidden are indistinguishable to the caller here.
      if (!row || row.hidden) {
        if (ifVersion !== undefined && ifVersion !== 0) {
          throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: 0 });
        }
        return { deleted: false as const };
      }
      const current = Number(row.version);
      if (ifVersion !== undefined && ifVersion !== current) {
        throw new DocStoreError('version_conflict', 'version conflict', {
          currentVersion: current,
        });
      }
      assertMayModify(ctx, coll, row);
      await c.query(SQL_DELETE_DOC, [ctx.appId, ctx.ns, coll.name, scope, key]);
      if (coll.config.visibility === 'shared') {
        await c.query(SQL_DELETE_MARKS, [ctx.appId, ctx.ns, coll.name, key]);
      }
      const size = Number(row.size_bytes);
      const seq = await charge(c, ctx, appDelta(scope, { bytes: -size, docs: -1 }), {
        uid: viewer,
        bytes: -size,
        docs: -1,
        ceiling: ceilingFor(coll),
      });
      await c.query(SQL_TOMBSTONE, [ctx.appId, ctx.ns, coll.name, scope, key, seq]);
      return { deleted: true as const, seq };
    });
  }

  /**
   * The report API's write: one `doc_mark` row named `report` per (document, viewer). No HookPass is
   * asked for: a hook must never be able to silence a report.
   */
  async function report(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string
  ): Promise<{ added: boolean }> {
    assertCollection(coll);
    assertKey(key);
    requireShared(coll, 'reports');
    const viewer = requireViewer(ctx);
    return withTx(ctx, async (c) => {
      const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
      if (doc.rows.length === 0) throw new DocStoreError('not_found', 'document not found');
      const ins = await c.query(SQL_INSERT_MARK, [
        ctx.appId,
        ctx.ns,
        coll.name,
        key,
        REPORT_MARK,
        viewer,
      ]);
      return { added: ins.rows.length > 0 };
    });
  }

  /**
   * List one collection. Filters combine with AND: one declared-index equality,
   * `author=me` and `keyPrefix`. Order is the sort field with the key as tiebreaker
   * (both in the requested direction), paged by keyset cursor. A sort or filter on an
   * index lists only documents that HAVE that index value.
   */
  async function list(
    ctx: DocStoreContext,
    coll: DocCollection,
    q: DocListQuery = {}
  ): Promise<DocListResult> {
    assertCollection(coll);
    const limit = q.limit ?? B.listLimitDefault;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > B.listLimitMax) {
      throw invalid(`limit must be 1–${B.listLimitMax}`);
    }
    const scope = scopeUid(ctx, coll);
    const sort = parseSort(coll, q.sort);

    const params: unknown[] = [ctx.appId, ctx.ns, coll.name, scope];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const joins: string[] = [];
    const conds: string[] = [];
    // The levels gate, next to `VISIBLE` (in `listBase`). The viewer is a parameter only there:
    // an unreferenced parameter is an untyped one, which Postgres refuses (42P18).
    if (ctx.levels) {
      conds.push(
        sharedDocLevelVisible(
          `${p(ctx.viewerUid)}::int`,
          `${p(ctx.levels.viewerLevel)}::int`,
          `${p(ctx.levels.domainLevel ?? ctx.levels.viewerLevel)}::int`
        )
      );
    }

    const where = Object.entries(q.where ?? {});
    if (where.length > B.equalityFilters) {
      throw invalid(`at most ${B.equalityFilters} equality filter`);
    }
    for (const [field, raw] of where) {
      const type = declaredIndexType(coll, field);
      if (!type) {
        throw new DocStoreError('index_not_declared', `${field} is not a declared index`, {
          field,
        });
      }
      const v = indexValue(type, raw, field);
      const cast = v.column === 'v_text' ? '::text' : '::float8';
      joins.push(
        listEqualityJoin(`${p(field)}::text`, `${p(type)}::text`, v.column, `${p(v.value)}${cast}`)
      );
    }

    if (q.keyPrefix !== undefined) {
      if (typeof q.keyPrefix !== 'string' || !/^[A-Za-z0-9._:-]{0,128}$/.test(q.keyPrefix)) {
        throw invalid('keyPrefix must be at most 128 characters of [A-Za-z0-9._:-]');
      }
      // Keys are ASCII ≤ 'z' (0x7A) and the column is COLLATE "C", so every key
      // with this prefix sorts in [prefix, prefix + '{') — an exact btree range.
      conds.push(`d.key >= ${p(q.keyPrefix)}::text AND d.key < ${p(`${q.keyPrefix}{`)}::text`);
    }
    if (q.author !== undefined) {
      if (q.author !== 'me') throw invalid('author must be "me"');
      conds.push(`d.author_kind = 'user' AND d.author_uid = ${p(requireViewer(ctx))}::int`);
    }
    let sortExpr = '';
    // The key column of the table that drives the sort, so the keyset cursor and
    // ORDER BY sit on one table's index for index sorts.
    let keyExpr = 'd.key';
    let sortValueExpr = `''`;
    let cursorCast = '';
    switch (sort.kind) {
      case 'key':
        break;
      case 'createdAt':
      case 'updatedAt': {
        const col = sort.kind === 'createdAt' ? 'd.created_at' : 'd.updated_at';
        sortExpr = col;
        // Exact microseconds since epoch; `extract` is numeric, so no float rounding.
        sortValueExpr = `((extract(epoch FROM ${col}) * 1000000)::bigint)::text`;
        cursorCast = `timestamptz 'epoch' + PARAM::bigint * interval '1 microsecond'`;
        break;
      }
      case 'index': {
        const col = indexColumn(sort.type);
        joins.push(listSortIndexJoin(`${p(sort.name)}::text`, `${p(sort.type)}::text`));
        sortExpr = `sx.${col}`;
        keyExpr = 'sx.key';
        sortValueExpr = col === 'v_text' ? `sx.v_text` : `sx.v_num::text`;
        cursorCast = col === 'v_text' ? `PARAM::text` : `PARAM::float8`;
        break;
      }
    }

    if (q.cursor !== undefined) {
      const cur = decodeCursor(sort, q.cursor);
      const op = sort.desc ? '<' : '>';
      if (sort.kind === 'key') {
        conds.push(`d.key ${op} ${p(cur.key)}::text`);
      } else {
        const v = cursorCast.replace('PARAM', p(cur.value));
        conds.push(`(${sortExpr}, ${keyExpr}) ${op} (${v}, ${p(cur.key)}::text)`);
      }
    }

    const dir = sort.desc ? 'DESC' : 'ASC';
    const orderBy = sortExpr ? `${sortExpr} ${dir}, ${keyExpr} ${dir}` : `d.key ${dir}`;
    const sql = [
      `SELECT ${docColumns(ctx.levels !== undefined)}, ${sortValueExpr} AS sort_value`,
      listBase(joins.join('\n')),
      ...conds.map((cnd) => `AND ${cnd}`),
      `ORDER BY ${orderBy}`,
      `LIMIT ${p(limit + 1)}::int`,
    ].join('\n');

    const rows = await withTx(ctx, async (c) => (await c.query(sql, params)).rows);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDocRecord(r, ctx)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(sort, String(last.sort_value), last.key as string)
          : null,
    };
  }

  /** The (app, ns) usage and the viewer's own share of it, in the stored unit. */
  async function usage(ctx: DocStoreContext): Promise<DocStoreUsage> {
    const toUsage = (row: Record<string, unknown> | undefined) => ({
      bytes: Number(row?.bytes ?? 0),
      docs: Number(row?.docs ?? 0),
    });
    return withTx(ctx, async (c) => {
      const app = (await c.query(SQL_USAGE_APP, [ctx.appId, ctx.ns])).rows[0];
      if (ctx.viewerUid === null) return { app: toUsage(app), viewer: null };
      const viewer = (await c.query(SQL_USAGE_USER, [ctx.appId, ctx.ns, ctx.viewerUid])).rows[0];
      return { app: toUsage(app), viewer: toUsage(viewer) };
    });
  }

  /**
   * Delete every row of every review namespace (`rev:<publishRequestId>:<moderatorUid>`) of one
   * publish request, from all seven tables, usage rows included, in ONE maintenance transaction:
   * all of it goes or none of it does. Idempotent. Called when the request is decided
   * (`teardownReviewStorageForRequest`) and by the sweep (`jobs/sweep-review-storage.ts`).
   * Returns the rows deleted (index rows removed by the document delete's foreign-key cascade are
   * not counted).
   */
  async function purgeReview(publishRequestId: string): Promise<{ rows: number }> {
    return maintenanceTx(publishRequestId, async (c) => {
      let rows = 0;
      for (const sql of SQL_REVIEW_PURGE) rows += await purgeRows(c, sql, [publishRequestId]);
      return { rows };
    });
  }

  /** Publish request ids that still hold review data, after `after`, at most `limit`. */
  async function listReviewAppIds(opts: { after?: string; limit: number }): Promise<string[]> {
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) {
      throw new Error('doc-store: limit must be 1–1000');
    }
    return maintenanceTx(null, async (c) =>
      (await c.query(SQL_REVIEW_APP_IDS, [opts.after ?? '', opts.limit])).rows.map(
        (r) => r.app_id as string
      )
    );
  }

  /** Every (app, ns) in which `userId` has a usage row or a mark, in key order, all pages. */
  async function listAccountNamespaces(userId: number): Promise<{ appId: string; ns: string }[]> {
    const out: { appId: string; ns: string }[] = [];
    let after = { appId: '', ns: '' };
    for (;;) {
      const page = await accountWipeTx(userId, async (c) =>
        (
          await c.query(SQL_ACCOUNT_NAMESPACES, [userId, after.appId, after.ns, ACCOUNT_WIPE_PAGE])
        ).rows.map((r) => ({ appId: r.app_id as string, ns: r.ns as string }))
      );
      out.push(...page);
      if (page.length < ACCOUNT_WIPE_PAGE) break;
      after = page[page.length - 1];
    }
    // The namespaces whose maintenance runs (purge dumps, run results) still name the user, where
    // that table exists: their rows outlive the documents and marks the first listing reads.
    const seen = new Set(out.map((p) => `${p.appId}\u0000${p.ns}`));
    let afterDump = { appId: '', ns: '' };
    for (;;) {
      const page = await accountWipeTx(
        userId,
        async (c) =>
          (await withMaintRun(c, async () =>
            (
              await c.query(SQL_ACCOUNT_DUMP_NAMESPACES, [
                userId,
                afterDump.appId,
                afterDump.ns,
                ACCOUNT_WIPE_PAGE,
              ])
            ).rows.map((r) => ({ appId: r.app_id as string, ns: r.ns as string }))
          )) ?? []
      );
      for (const p of page) {
        if (!seen.has(`${p.appId}\u0000${p.ns}`)) out.push(p);
      }
      if (page.length < ACCOUNT_WIPE_PAGE) break;
      afterDump = page[page.length - 1];
    }
    return out.sort((a, b) =>
      a.appId === b.appId ? (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0) : a.appId < b.appId ? -1 : 1
    );
  }

  /** One (app, ns) of an account wipe, in ONE ordinary scoped transaction: all of it or none. */
  async function wipeAccountNamespace(
    userId: number,
    appId: string,
    ns: string
  ): Promise<AccountWipeNamespaceResult> {
    // The viewer is the account being wiped. Enumeration only finds namespaces the account has
    // rows in, and through the store only its own tokens can write into a review namespace, so
    // `assertContext`'s review-namespace check passes for every namespace the store could have
    // produced. (A row put into another moderator's review namespace by hand would be refused
    // here and reported in `failures`.)
    const ctx: DocStoreContext = { appId, ns, viewerUid: userId };
    const result: AccountWipeNamespaceResult = {
      appId,
      ns,
      mode: ownsNamespace(userId, ns) ? 'namespace' : 'user',
      privateDocs: 0,
      privateBytes: 0,
      sharedDocs: 0,
      sharedBytes: 0,
      marks: 0,
      namespaceRows: 0,
      maintRunsScrubbed: 0,
    };
    const n = (res: DocStoreQueryResult, col = 'n') => Number(res.rows[0]?.[col] ?? 0);
    return withTx(ctx, async (c) => {
      if (result.mode === 'namespace') {
        for (const sql of SQL_WIPE_NAMESPACE)
          result.namespaceRows += await purgeRows(c, sql, [appId, ns]);
        return result;
      }
      const args = [appId, ns, userId];
      /**
       * The document rows (LOCK ORDER (1)): every shared document the wipe touches is locked in
       * one ordered statement (`SQL_WIPE_LOCK_DOCS`), then the private documents are deleted.
       * Nothing is charged here; `settle` does that once every
       * row lock is held.
       */
      const wipeDocs = async () => {
        const locked = (await c.query(SQL_WIPE_LOCK_DOCS, args)).rows;
        const authored = locked.filter((r) => r.authored === true).map(toLockedSharedDoc);
        const priv = await c.query(SQL_WIPE_PRIVATE_DOCS, args);
        const deleted = { docs: n(priv, 'docs'), bytes: n(priv, 'bytes') };
        result.privateDocs += deleted.docs;
        result.privateBytes += deleted.bytes;
        return { authored, deleted };
      };
      /**
       * Delete the locked authored documents exactly as a moderator delete does (every report on
       * them, app and author refunds, tombstones). The private documents refund nothing: the app's
       * ceiling never carried them (`appDelta`), and the account's own usage row, which did, is
       * deleted below. Their zero-byte charge is kept for its lock: it takes `usage_app` (LOCK
       * ORDER (2)) before the usage-row delete takes (3), as it did when it refunded bytes, so
       * an in-flight write by this user cannot hold (2) while waiting on a (3) the wipe holds.
       */
      const settle = async (pass: Awaited<ReturnType<typeof wipeDocs>>) => {
        result.sharedDocs += pass.authored.length;
        result.sharedBytes += pass.authored.reduce((sum, d) => sum + d.sizeBytes, 0);
        await deleteLockedSharedDocs(c, ctx, charge, pass.authored);
        if (pass.deleted.docs > 0) {
          await charge(
            c,
            ctx,
            // Their key space is `scope_uid = userId` (`SQL_WIPE_PRIVATE_DOCS`).
            appDelta(userId, { bytes: -pass.deleted.bytes, docs: -pass.deleted.docs }),
            { uid: 0, bytes: 0, docs: 0, ceiling: 'viewer' }
          );
        }
      };
      const first = await wipeDocs();
      // Every report row this deletes is on a document `wipeDocs` locked.
      result.marks = n(await c.query(SQL_WIPE_MARKS, args), 'marks');
      await settle(first);
      // A write by this user that was in flight when the statements above took their snapshots
      // holds its `usage_user` row until it commits; this delete waits for it, and then deletes
      // the row that counted that document. The second pass (a new statement, so a new
      // snapshot) sees what that writer committed, so no document naming the user outlives the
      // usage row a re-run would find it by. A write that starts later recreates the row and is
      // found by a re-run. The second pass re-runs the single ordered lock statement, so it
      // takes document locks after the usage locks — the reverse of LOCK ORDER. It already holds
      // every document lock from the first pass, so a new lock can only be on a document the
      // in-flight writer created or a document this user reported meanwhile. That document can
      // also be locked by someone else (a moderator delete, or another wipe) who then waits on
      // this user's usage row, so the second pass can deadlock with them in that narrow window.
      // Postgres then aborts one side whole; for this wipe the namespace is reported in
      // `failures` for a re-run.
      await c.query(SQL_WIPE_USAGE_USER, args);
      await settle(await wipeDocs());
      // The second pass refunds the author of any document it deleted, which re-creates the
      // usage row it just charged (as a negative); remove it again.
      await c.query(SQL_WIPE_USAGE_USER, args);
      await c.query(SQL_WIPE_PRIVATE_TOMBS, args);
      // After every document lock (the maintenance runs come after documents in the lock order).
      result.maintRunsScrubbed = await scrubMaintRuns(c, ctx, userId);
      return result;
    });
  }

  /**
   * ACCOUNT WIPE (`removeAllContent`, a moderator content-removal action): remove one user from
   * the document store, in every app and namespace they have rows in. Per namespace, in one
   * transaction:
   *   - their own dev namespace (`dev:<uid>`) is deleted outright;
   *   - elsewhere, their private documents are deleted (index rows with them; the app's usage
   *     never carried them, so it is not refunded); their reports are deleted; the shared
   *     documents they authored are DELETED, hidden or not, exactly as a moderator delete does
   *     (index rows, every user's reports on them, app and author refunds, tombstones); their
   *     usage rows and private tombstones are deleted.
   * Idempotent: a re-run finds nothing left that names the user. A namespace whose transaction
   * fails is reported in `failures` (it rolled back in full) and the rest continue; a disabled
   * store throws `storage_disabled`.
   *
   * `proceed` is awaited before EVERY namespace; false stops the wipe there (`stopped`), which is
   * how a caller re-checks that the wipe is still wanted (the account was not restored or put
   * under a hold meanwhile). The namespaces already wiped stay wiped. `doc-store-purge.ts` is the
   * server's one entry point.
   */
  async function wipeAccount(
    userId: number,
    opts: { proceed?: () => Promise<boolean> } = {}
  ): Promise<AccountWipeResult> {
    assertWipeUserId(userId);
    const result: AccountWipeResult = { userId, namespaces: [], failures: [], stopped: false };
    for (const { appId, ns } of await listAccountNamespaces(userId)) {
      if (opts.proceed && !(await opts.proceed())) return { ...result, stopped: true };
      try {
        result.namespaces.push(await wipeAccountNamespace(userId, appId, ns));
      } catch (err) {
        if (err instanceof DocStoreError && err.code === 'storage_disabled') throw err;
        result.failures.push({
          appId,
          ns,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  /** Namespaces enumerated per page by an app purge. */
  const APP_PURGE_PAGE = 500;

  /** Every namespace `appId` has rows in, in key order, all pages. Refuses without the policy. */
  async function listAppNamespaces(appId: string): Promise<string[]> {
    const out: string[] = [];
    let after = '';
    for (;;) {
      const page = await appPurgeTx(appId, async (c) => {
        const policies = Number((await c.query(SQL_APP_PURGE_POLICY)).rows[0]?.n ?? 0);
        if (policies !== 2) {
          throw new DocStoreMigrationPendingError(
            '20261102120000_appdata_app_purge.sql',
            'doc-store: the app-purge policy is not installed (apply migration 20261102120000_appdata_app_purge.sql)'
          );
        }
        return (await c.query(SQL_APP_NAMESPACES, [appId, after, APP_PURGE_PAGE])).rows.map(
          (r) => r.ns as string
        );
      });
      out.push(...page);
      if (page.length < APP_PURGE_PAGE) return out;
      after = page[page.length - 1];
    }
  }

  /**
   * APP PURGE (the deleted-app reaper, `jobs/reap-deleted-app-storage.ts`): delete every row of
   * one app, in every namespace it has rows in, every user's data included. Namespaces come from
   * the app-purge enumeration (`listAppNamespaces`); each is then deleted in ordinary
   * (app, ns)-scoped transactions of at most `batchRows` rows of one table each
   * (`SQL_APP_PURGE_BATCH`), and finished by `SQL_WIPE_NAMESPACE`, which deletes what is left,
   * usage rows included. Until that last transaction a namespace's usage rows still count the
   * documents a batch already deleted; the app is not served by then, and the rows go with it.
   *
   * `proceed` is awaited before EVERY transaction; false stops the purge where it is (`stopped`),
   * which is how a caller re-checks, between batches, that the app is still deleted. At most
   * `maxRows` rows are deleted per call (`done: false` when the budget ran out first).
   * `done: true` only when a second enumeration after the pass finds nothing: a namespace that
   * received its first write after the first enumeration returns `done: false`, and the next call
   * deletes it. Idempotent and resumable: a re-run finds only what is left. A disabled store throws
   * `storage_disabled`, a missing app-purge policy `DocStoreMigrationPendingError`; a failed
   * transaction throws, having rolled back only its own batch.
   */
  async function purgeApp(
    appId: string,
    opts: { batchRows?: number; maxRows?: number; proceed?: () => Promise<boolean> } = {}
  ): Promise<{ appId: string; namespaces: number; rows: number; done: boolean; stopped: boolean }> {
    const batchRows = opts.batchRows ?? 1000;
    const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
    if (!Number.isSafeInteger(batchRows) || batchRows < 1 || batchRows > 10_000) {
      throw new Error('doc-store: batchRows must be 1–10000');
    }
    const proceed = opts.proceed ?? (async () => true);
    const namespaces = await listAppNamespaces(appId);
    const result = { appId, namespaces: namespaces.length, rows: 0, done: false, stopped: false };
    const n = (res: DocStoreQueryResult) => Number(res.rows[0]?.n ?? 0);
    for (const ns of namespaces) {
      const ctx: DocStoreContext = { appId, ns, viewerUid: null };
      for (const sql of SQL_APP_PURGE_BATCH) {
        for (;;) {
          if (result.rows >= maxRows) return result;
          if (!(await proceed())) return { ...result, stopped: true };
          const deleted = await withTx(ctx, async (c) =>
            n(await c.query(sql, [appId, ns, batchRows]))
          );
          result.rows += deleted;
          if (deleted < batchRows) break;
        }
      }
      if (!(await proceed())) return { ...result, stopped: true };
      result.rows += await withTx(ctx, async (c) => {
        let rows = 0;
        for (const sql of SQL_WIPE_NAMESPACE) rows += await purgeRows(c, sql, [appId, ns]);
        return rows;
      });
    }
    if (namespaces.length > 0 && (await listAppNamespaces(appId)).length > 0) return result;
    return { ...result, done: true };
  }

  /**
   * SCHEMA MIGRATION (`storage-migration-run.service.ts`): run `transform` over ONE PAGE of one
   * collection's PRODUCTION documents — every key space, hidden documents included — after
   * `opts.after` (exclusive), and store what it returns. Development (`dev:`) and review (`rev:`)
   * namespaces are not touched: they hold test data, which the developer resets.
   *
   * Each document is its own transaction: re-read under its row lock, transformed, and written
   * only when `transform` returns a body (null = unchanged). So a viewer's write that lands
   * between the page read and the lock is what gets transformed: the transform must leave a
   * document already in the new shape unchanged (the migration ops do — `applyMigrationOps`), and
   * then a write racing the run, or a re-run of the same page, is safe. A changed document gets a new version
   * and seq (and `coll.schemaMajor` as its schema major, as any write stamps it), its index rows are re-derived, and its size delta is charged exactly as a write
   * would charge it (the app's ceiling for a shared document, and the user the document is
   * charged to: its viewer for a private one, its author for a shared one).
   * A document the write would refuse — over the size cap, an index value of the wrong type, a
   * ceiling it no longer fits under — is left as it was and counted in `failed`.
   *
   * `invalid` counts the documents (changed or not) that still do not match the collection's
   * schema afterwards — what an `acknowledge` op accepted. `next` is the cursor of the next page,
   * or null when this one was the last.
   */
  /** Whose per-user usage a migrated document's size change is charged to; null for none. */
  function migrationOwner(scope: number, row: Record<string, unknown>): number | null {
    if (scope !== 0) return scope;
    return row.author_kind === 'user' && row.author_uid !== null && row.author_uid !== undefined
      ? Number(row.author_uid)
      : null;
  }

  async function migrateDocuments(
    appId: string,
    coll: DocCollection,
    transform: (data: Record<string, unknown>) => Record<string, unknown> | null,
    opts: { after?: MigrationCursor | null; limit?: number } = {}
  ): Promise<MigrateDocumentsResult> {
    assertCollection(coll);
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('doc-store: limit must be 1–1000');
    }
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: null };
    const after = opts.after ?? { scopeUid: -1, key: '' };
    const page = await withTx(ctx, async (c) =>
      (
        await c.query(SQL_MIGRATE_PAGE, [
          appId,
          ctx.ns,
          coll.name,
          after.scopeUid,
          after.key,
          limit,
        ])
      ).rows.map((r) => ({
        scopeUid: Number(r.scope_uid),
        key: r.key as string,
        owner: migrationOwner(Number(r.scope_uid), r),
      }))
    );
    // Each owner's ceiling, once per page and before any document's transaction: a migration
    // charges its documents' owners, and must not resolve their tiers under the usage-row lock.
    await resolveCeilings(
      ctx,
      page.flatMap((d) => (d.owner === null ? [] : [d.owner]))
    );
    const result: MigrateDocumentsResult = {
      scanned: 0,
      migrated: 0,
      unchanged: 0,
      failed: 0,
      invalid: 0,
      failures: [],
      next:
        page.length < limit
          ? null
          : { scopeUid: page[page.length - 1].scopeUid, key: page[page.length - 1].key },
    };
    const stillInvalid = (data: unknown) => {
      try {
        validateDocAgainstCollectionSchema(ctx, coll, data);
        return false;
      } catch {
        return true;
      }
    };
    for (const { scopeUid: scope, key } of page) {
      const base = [appId, ctx.ns, coll.name, scope, key];
      try {
        const migrateOne = () =>
          withTx(ctx, async (c) => {
            const row = (await c.query(SQL_MIGRATE_LOCK_DOC, base)).rows[0];
            if (!row) return null; // deleted since the page was read
            const before = row.data as Record<string, unknown>;
            const next = transform(before);
            if (next === null) return { changed: false, invalid: stillInvalid(before) };
            const json = serializeData(next);
            const indexRows = indexRowsFor(coll, next);
            const res = await c.query(SQL_MIGRATE_DOC, [...base, json]);
            const delta = Number(res.rows[0].size_bytes) - Number(row.size_bytes);
            const owner = migrationOwner(scope, row);
            await c.query(SQL_SYNC_INDEX, [
              appId,
              ctx.ns,
              coll.name,
              scope,
              key,
              indexRows.map((r) => r.name),
              indexRows.map((r) => r.vText),
              indexRows.map((r) => r.vNum),
              indexRows.map((r) => r.type),
            ]);
            const seq = await charge(
              c,
              ctx,
              appDelta(scope, { bytes: delta, docs: 0 }),
              owner === null
                ? { uid: 0, bytes: 0, docs: 0, ceiling: 'author' }
                : {
                    uid: owner,
                    bytes: delta,
                    docs: 0,
                    ceiling: scope !== 0 ? 'viewer' : 'author',
                  }
            );
            await stampWrittenDoc(c, ctx, coll, scope, key, seq);
            return { changed: true, invalid: stillInvalid(next) };
          });
        // A lock wait that timed out (a burst of writes to this app) is retried once; the
        // transform is idempotent, so a second pass over a document is safe.
        const outcome = await migrateOne().catch((err) => {
          if (isDocStoreError(err, 'rate_limited')) return migrateOne();
          throw err;
        });
        result.scanned += 1;
        if (outcome === null) continue;
        if (outcome.changed) result.migrated += 1;
        else result.unchanged += 1;
        if (outcome.invalid) result.invalid += 1;
      } catch (err) {
        // A disabled or unreachable store fails every document alike: stop the page.
        if (
          isDocStoreError(err, 'storage_disabled') ||
          isDocStoreError(err, 'service_unavailable')
        ) {
          throw err;
        }
        result.scanned += 1;
        result.failed += 1;
        if (result.failures.length < MIGRATION_FAILURE_SAMPLES) {
          result.failures.push({
            scopeUid: scope,
            key,
            code: err instanceof DocStoreError ? err.code : 'internal',
          });
        }
      }
    }
    return result;
  }

  // MAINTENANCE RUNS (`appdata.maint_run`): what is left of the rollout step 4 tooling, run in the
  // production namespace.

  const maintCtx = (appId: string): DocStoreContext => ({
    appId,
    ns: PUBLISHED_NS,
    viewerUid: null,
  });

  /** Run `fn`, which names `appdata.maint_run`, refusing where the table does not exist. */
  async function maintRunRequired<T>(c: DocStoreClient, fn: () => Promise<T>): Promise<T> {
    const out = await withMaintRun(c, async () => ({ value: await fn() }));
    if (out === null) {
      throw new DocStoreMigrationPendingError(
        MAINT_RUN_MIGRATION,
        `doc-store: the maintenance-run table is not installed (apply migration ${MAINT_RUN_MIGRATION})`
      );
    }
    return out.value;
  }

  function toMaintRun(r: Record<string, unknown>): MaintRun {
    return {
      collection: r.coll as string,
      kind: r.kind as MaintRun['kind'],
      name: r.name as string,
      status: r.status as string,
      params: (r.params ?? {}) as Record<string, unknown>,
      result: (r.result ?? {}) as Record<string, unknown>,
      actorUid: r.actor_uid === null || r.actor_uid === undefined ? null : Number(r.actor_uid),
      createdAt: new Date(r.created_at as string | Date),
      updatedAt: new Date(r.updated_at as string | Date),
    };
  }

  /** Every maintenance run of the app's production namespace, without dumps. None without the table. */
  async function listMaintRuns(appId: string): Promise<MaintRun[]> {
    const ctx = maintCtx(appId);
    return withTx(ctx, async (c) => {
      const rows = await withMaintRun(
        c,
        async () => (await c.query(SQL_MAINT_RUN_LIST, [appId, ctx.ns])).rows
      );
      return (rows ?? []).map(toMaintRun);
    });
  }

  /** One purge's dump, every batch in order; null when no batch of it holds one (or they expired). */
  async function purgeDump(
    appId: string,
    args: { collection: string; runId: string }
  ): Promise<PurgeDump | null> {
    if (!B.collectionName.test(args.collection)) throw invalid('invalid collection name');
    if (!/^[0-9A-Z]{26}$/.test(args.runId)) throw invalid('invalid run id');
    const ctx = maintCtx(appId);
    return withTx(ctx, async (c) => {
      const rows = await maintRunRequired(
        c,
        async () =>
          (
            await c.query(SQL_MAINT_RUN_DUMPS, [appId, ctx.ns, args.collection, `${args.runId}.%`])
          ).rows
      );
      if (rows.length === 0) return null;
      const out: PurgeDump = { docs: [], index: [], tallies: [], marks: [] };
      for (const r of rows) {
        const d = r.dump as PurgeDump;
        out.docs.push(...d.docs);
        out.index.push(...d.index);
        out.tallies.push(...d.tallies);
        out.marks.push(...d.marks);
      }
      return out;
    });
  }

  /**
   * ACCOUNT DELETION reaches the maintenance runs (operator decision: the wipe covers dumps):
   * every row naming `userId` — as a dumped document's author, last writer or hider, as a dumped
   * mark's (or report's) user, in a purge's refunds, a copy's over-ceiling list or a verify's
   * per-user sample (`maintRunNamesUser`) — loses it. A
   * dumped document the user authored goes whole, with its index, tally and mark rows; the rest
   * keep only what names someone else. Runs in the wipe's own transaction, after its document locks.
   */
  async function scrubMaintRuns(c: DocStoreClient, ctx: DocStoreContext, userId: number) {
    const rows = await withMaintRun(
      c,
      async () => (await c.query(SQL_MAINT_RUN_NAMING_USER, [ctx.appId, ctx.ns, userId])).rows
    );
    let scrubbed = 0;
    for (const r of rows ?? []) {
      const dump = (r.dump ?? null) as PurgeDump | null;
      let nextDump: PurgeDump | null = dump;
      if (dump) {
        const gone = new Set(dump.docs.filter((d) => d.authorUid === userId).map((d) => d.key));
        nextDump = {
          docs: dump.docs
            .filter((d) => !gone.has(d.key))
            .map((d) => ({
              ...d,
              lastWriterUid: d.lastWriterUid === userId ? null : d.lastWriterUid,
              hiddenBy: d.hiddenBy === userId ? null : d.hiddenBy,
            })),
          index: dump.index.filter((x) => !gone.has(x.key)),
          tallies: dump.tallies.filter((t) => !gone.has(t.key)),
          marks: dump.marks.filter((m) => !gone.has(m.key) && m.userId !== userId),
        };
      }
      const result = { ...((r.result ?? {}) as Record<string, unknown>) };
      if (Array.isArray(result.refunds)) {
        result.refunds = (result.refunds as { userId: number }[]).filter(
          (x) => x.userId !== userId
        );
      }
      const copy = result.copy as { overCeiling?: number[] } | undefined;
      if (copy && Array.isArray(copy.overCeiling)) {
        result.copy = { ...copy, overCeiling: copy.overCeiling.filter((u) => u !== userId) };
      }
      const verify = result.verify as { userSample?: { id: string }[] } | undefined;
      if (verify && Array.isArray(verify.userSample)) {
        result.verify = {
          ...verify,
          userSample: verify.userSample.filter((x) => x.id !== String(userId)),
        };
      }
      await c.query(SQL_MAINT_RUN_SCRUB, [
        ctx.appId,
        ctx.ns,
        r.coll,
        r.kind,
        r.name,
        nextDump === null ? null : JSON.stringify(nextDump),
        JSON.stringify(result),
      ]);
      scrubbed += 1;
    }
    return scrubbed;
  }

  /**
   * RETENTION: drop the dumps of every purge that finished `days` ago (default
   * {@link PURGE_DUMP_RETENTION_DAYS}) or was abandoned (still `purging` that long after it
   * started); the header, with its counts, stays.
   */
  async function expireMaintDumps(
    appId: string,
    opts: { days?: number } = {}
  ): Promise<{ dumps: number }> {
    const days = opts.days ?? PURGE_DUMP_RETENTION_DAYS;
    if (!Number.isSafeInteger(days) || days < 1) throw new Error('doc-store: days must be ≥ 1');
    const ctx = maintCtx(appId);
    return withTx(ctx, async (c) => {
      const n = await withMaintRun(c, async () => {
        await c.query(SQL_MAINT_RUN_ABANDON_PURGES, [appId, ctx.ns, days]);
        return Number(
          (await c.query(SQL_MAINT_RUN_EXPIRE_DUMPS, [appId, ctx.ns, days])).rows[0]?.n ?? 0
        );
      });
      return { dumps: n ?? 0 };
    });
  }

  /**
   * The apps in which `userId` holds production documents, with their stored usage — the same
   * figure the per-viewer ceiling (`userBytes` / `userDocs`) is checked against: their private
   * documents and the shared documents they authored. One indexed read per page, never a read per app.
   */
  async function listViewerUsage(userId: number): Promise<ViewerAppUsage[]> {
    assertWipeUserId(userId);
    const out: ViewerAppUsage[] = [];
    let after = '';
    for (;;) {
      const page = await accountWipeTx(userId, async (c) =>
        (
          await c.query(SQL_VIEWER_PROD_USAGE, [userId, after, ACCOUNT_WIPE_PAGE])
        ).rows.map((r) => ({
          appId: r.app_id as string,
          bytes: Number(r.bytes),
          docs: Number(r.docs),
        }))
      );
      out.push(...page);
      if (page.length < ACCOUNT_WIPE_PAGE) return out;
      after = page[page.length - 1].appId;
    }
  }

  /**
   * What `userId`'s production figure in one app is made of, by what `emptyViewerData` does with
   * each part (`ViewerAppHoldings`). One aggregate read in a scoped transaction; the parts sum to
   * the stored usage (`listViewerUsage`).
   */
  async function viewerHoldings(userId: number, appId: string): Promise<ViewerAppHoldings> {
    assertWipeUserId(userId);
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: userId };
    const rows = await withTx(
      ctx,
      async (c) => (await c.query(SQL_VIEWER_HOLDINGS, [appId, PUBLISHED_NS, userId])).rows
    );
    const part = (name: string) => {
      const r = rows.find((row) => row.part === name);
      return { bytes: Number(r?.bytes ?? 0), docs: Number(r?.docs ?? 0) };
    };
    return {
      private: part('private'),
      shared: part('shared'),
      hidden: part('hidden'),
    };
  }

  /** One page of the documents `userId` owns in one app, for their export (`SQL_VIEWER_RECORDS`). */
  async function viewerRecords(
    userId: number,
    appId: string,
    opts: { after?: ViewerRecordCursor | null; limit: number }
  ): Promise<ViewerRecordRow[]> {
    assertWipeUserId(userId);
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000) {
      throw new Error('doc-store: limit must be 1–1000');
    }
    const after = opts.after ?? { coll: '', scopeUid: -1, key: '' };
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: userId };
    const rows = await withTx(
      ctx,
      async (c) =>
        (
          await c.query(SQL_VIEWER_RECORDS, [
            appId,
            PUBLISHED_NS,
            userId,
            after.coll,
            after.scopeUid,
            after.key,
            opts.limit,
          ])
        ).rows
    );
    return rows.map((r) => ({
      coll: r.coll as string,
      scopeUid: Number(r.scope_uid),
      key: r.key as string,
      data: r.data as Record<string, unknown>,
      version: Number(r.version),
      author: rowAuthor(r, userId),
      lastWriterUid: r.last_writer_uid === null ? null : Number(r.last_writer_uid),
      recordId: r.record_id === null || r.record_id === undefined ? null : String(r.record_id),
    }));
  }

  /**
   * Empty what one viewer holds in one app's PRODUCTION namespace, in ONE scoped transaction:
   *   - always: their private documents (index rows with them), each refunded to their own usage
   *     (the app's never carried them, `appDelta`) and tombstoned, as `remove` does;
   *   - with `shared`: also the VISIBLE shared documents they authored, deleted exactly as an
   *     author or moderator delete does (`deleteLockedSharedDocs`: index rows, every viewer's
   *     reports, app and author refunds, tombstones). A hidden one stays for moderation.
   * Their reports on other documents stay.
   * Idempotent: a re-run finds nothing and writes nothing.
   */
  async function emptyViewerData(
    userId: number,
    appId: string,
    opts: { shared: boolean }
  ): Promise<ViewerDataEmptyResult> {
    assertWipeUserId(userId);
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: userId };
    const args = [appId, PUBLISHED_NS, userId];
    return withTx(ctx, async (c) => {
      const authored = opts.shared
        ? (await c.query(SQL_EMPTY_LOCK_AUTHORED, args)).rows.map(toLockedSharedDoc)
        : [];
      const priv = (await c.query(SQL_EMPTY_PRIVATE_DOCS, args)).rows;
      const privateBytes = priv.reduce((sum, r) => sum + Number(r.size_bytes), 0);
      await deleteLockedSharedDocs(c, ctx, charge, authored);
      if (priv.length > 0) {
        const seq = await charge(
          c,
          ctx,
          // Their key space is `scope_uid = userId` (`SQL_EMPTY_PRIVATE_DOCS`).
          appDelta(userId, { bytes: -privateBytes, docs: -priv.length }),
          { uid: userId, bytes: -privateBytes, docs: -priv.length, ceiling: 'viewer' }
        );
        await c.query(SQL_TOMBSTONE_MANY, [
          appId,
          PUBLISHED_NS,
          userId,
          seq,
          priv.map((r) => r.coll as string),
          priv.map((r) => r.key as string),
        ]);
      }
      return {
        privateDocs: priv.length,
        privateBytes,
        sharedDocs: authored.length,
        sharedBytes: authored.reduce((sum, d) => sum + d.sizeBytes, 0),
      };
    });
  }

  const store = {
    get,
    getMany,
    put,
    putIfUnchanged,
    create,
    delete: remove,
    list,
    report,
    usage,
    limits,
    viewerLimits,
    isUsable,
  };
  /**
   * Shared documents of `appId` under `key` in any of `collections`, production namespace only,
   * hidden included: at most two, enough to tell one match from several. Nothing is queried when
   * there is no valid collection or key.
   */
  async function findSharedByKey(
    appId: string,
    collections: readonly string[],
    key: string,
    opts: { rating?: boolean } = {}
  ): Promise<SharedKeyMatch[]> {
    const names = collections.filter((n) => B.collectionName.test(n));
    if (names.length === 0 || !B.key.test(key) || DOT_ONLY_KEY.test(key)) return [];
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: null };
    const params = [ctx.appId, ctx.ns, names, key];
    const rows = await withTx(
      ctx,
      async (c) =>
        (opts.rating
          ? await c.query(SQL_LOOKUP_SHARED_KEY_LEVELS, params)
          : await c.query(SQL_LOOKUP_SHARED_KEY, params)
        ).rows
    );
    return rows.map((r) => ({
      collection: r.coll as string,
      authorUid: r.author_uid === null || r.author_uid === undefined ? null : Number(r.author_uid),
      hidden: r.hidden === true,
      ...(opts.rating ? { rating: toDocRating(r) } : {}),
    }));
  }

  /**
   * The registry feed's context: the production namespace of one app, no viewer. Collection
   * names, keys and seq bounds are checked here, before any of them reaches SQL.
   */
  function feedCtx(appId: string, coll: string): DocStoreContext {
    if (!B.collectionName.test(coll)) throw invalid('feed: malformed collection name');
    return { appId, ns: PUBLISHED_NS, viewerUid: null };
  }
  const feedSeq = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) throw invalid('feed: malformed seq');
    return n;
  };
  const feedLimit = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > FEED_MAX_PAGE)
      throw invalid('feed: bad page size');
    return n;
  };
  const seqOf = (v: unknown) => Number(v);

  /** The namespace's newest seq, or 0 when it has no usage row (nothing was ever written). */
  async function feedHead(appId: string): Promise<number> {
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: null };
    const row = await withTx(
      ctx,
      async (c) => (await c.query(SQL_FEED_HEAD, [ctx.appId, ctx.ns])).rows[0]
    );
    return row ? seqOf(row.last_seq) : 0;
  }

  /**
   * One page of what changed in a shared collection in the seq range (`after`, `upTo`]:
   * documents written (hidden ones flagged) and tombstones, each in seq order. One transaction,
   * one app namespace.
   */
  async function feedChanges(
    appId: string,
    coll: string,
    after: number,
    upTo: number,
    limit: number,
    levels?: DocLevelGate
  ): Promise<FeedChangesPage> {
    const ctx = feedCtx(appId, coll);
    const params = [ctx.appId, ctx.ns, coll, feedSeq(after), feedSeq(upTo), feedLimit(limit)];
    return withTx(ctx, async (c) => {
      const docs = (
        levels
          ? await c.query(SQL_FEED_DOCS_SINCE_LEVELS, [...params, levels.viewerLevel])
          : await c.query(SQL_FEED_DOCS_SINCE, params)
      ).rows;
      const tombs = (await c.query(SQL_FEED_TOMBS_SINCE, params)).rows;
      return {
        docs: docs.map((r) => ({
          key: r.key as string,
          data: r.data as Record<string, unknown>,
          version: Number(r.version),
          seq: seqOf(r.seq),
          hidden: r.hidden === true,
        })),
        tombs: tombs.map((r) => ({ key: r.key as string, seq: seqOf(r.seq) })),
      };
    });
  }

  /** One page of a shared collection's visible documents at or below `upTo`, by key. */
  async function feedDocuments(
    appId: string,
    coll: string,
    afterKey: string,
    upTo: number,
    limit: number,
    levels?: DocLevelGate
  ): Promise<FeedDocument[]> {
    const ctx = feedCtx(appId, coll);
    if (afterKey !== '' && !B.key.test(afterKey)) throw invalid('feed: malformed key');
    const params = [ctx.appId, ctx.ns, coll, afterKey, feedSeq(upTo), feedLimit(limit)];
    const rows = await withTx(
      ctx,
      async (c) =>
        (levels
          ? await c.query(SQL_FEED_DOCS_ALL_LEVELS, [...params, levels.viewerLevel])
          : await c.query(SQL_FEED_DOCS_ALL, params)
        ).rows
    );
    return rows.map((r) => ({
      key: r.key as string,
      data: r.data as Record<string, unknown>,
      version: Number(r.version),
      seq: seqOf(r.seq),
    }));
  }

  /** Where one shared key stands now: its document's seq and its tombstone's, each or null. */
  async function feedWitness(
    appId: string,
    coll: string,
    key: string
  ): Promise<{ docSeq: number | null; tombSeq: number | null }> {
    const ctx = feedCtx(appId, coll);
    if (!B.key.test(key)) throw invalid('feed: malformed key');
    return withTx(ctx, async (c) => {
      const params = [ctx.appId, ctx.ns, coll, key];
      const doc = (await c.query(SQL_FEED_WITNESS_DOC, params)).rows[0];
      const tomb = (await c.query(SQL_FEED_WITNESS_TOMB, params)).rows[0];
      return {
        docSeq: doc ? seqOf(doc.seq) : null,
        tombSeq: tomb ? seqOf(tomb.seq) : null,
      };
    });
  }

  const levelBit = (selector: LevelSelector): number | null => {
    if (selector === 'none') return null;
    if (!(LEVEL_STREAM_BITS as readonly number[]).includes(selector.bit)) {
      throw invalid('feed: not a level bit');
    }
    return selector.bit;
  };
  const levelSql = (selector: LevelSelector, bit: string, none: string) =>
    selector === 'none' ? none : bit;
  const levelRow = (r: Record<string, unknown>): LevelStreamDocument => ({
    key: r.key as string,
    data: r.data as Record<string, unknown>,
    version: Number(r.version),
    seq: seqOf(r.seq),
    createdAt: new Date(r.created_at as string | Date).toISOString(),
    updatedAt: new Date(r.updated_at as string | Date).toISOString(),
  });

  /**
   * One page of what changed in a shared collection in the seq range (`after`, `upTo`], for one
   * level stream: every document written (each flagged whether it is on the stream now: visible
   * and selected) and every tombstone, each in seq order. One transaction, one app namespace.
   */
  async function levelChanges(
    appId: string,
    coll: string,
    selector: LevelSelector,
    after: number,
    upTo: number,
    limit: number
  ): Promise<LevelChangesPage> {
    const ctx = feedCtx(appId, coll);
    const bit = levelBit(selector);
    const params = [ctx.appId, ctx.ns, coll, feedSeq(after), feedSeq(upTo), feedLimit(limit)];
    return withTx(ctx, async (c) => {
      const sql = levelSql(selector, SQL_LEVEL_DOCS_SINCE_BIT, SQL_LEVEL_DOCS_SINCE_NONE);
      const docs = (await c.query(sql, bit === null ? params : [...params, bit])).rows;
      const tombs = (await c.query(SQL_FEED_TOMBS_SINCE, params)).rows;
      return {
        docs: docs.map((r) => ({ ...levelRow(r), onStream: r.on_stream === true })),
        tombs: tombs.map((r) => ({ key: r.key as string, seq: seqOf(r.seq) })),
      };
    });
  }

  /**
   * One page of a level stream's documents at or below `upTo`, NEWEST KEY FIRST, before
   * `beforeKey` ('' = from the newest).
   */
  async function levelDocuments(
    appId: string,
    coll: string,
    selector: LevelSelector,
    beforeKey: string,
    upTo: number,
    limit: number
  ): Promise<LevelStreamDocument[]> {
    const ctx = feedCtx(appId, coll);
    const bit = levelBit(selector);
    if (beforeKey !== '' && !B.key.test(beforeKey)) throw invalid('feed: malformed key');
    const params = [ctx.appId, ctx.ns, coll, beforeKey, feedSeq(upTo), feedLimit(limit)];
    const sql = levelSql(selector, SQL_LEVEL_DOCS_DESC_BIT, SQL_LEVEL_DOCS_DESC_NONE);
    const rows = await withTx(
      ctx,
      async (c) => (await c.query(sql, bit === null ? params : [...params, bit])).rows
    );
    return rows.map(levelRow);
  }

  /** The private feed's bound values, checked before any of them reaches SQL. */
  function privateFeedParams(
    appId: string,
    coll: string,
    userId: number,
    afterKey: string,
    limit: number
  ) {
    const ctx = feedCtx(appId, coll);
    assertWipeUserId(userId);
    if (afterKey !== '' && !B.key.test(afterKey)) throw invalid('feed: malformed key');
    return {
      ctx,
      params: [ctx.appId, ctx.ns, coll, userId, afterKey, feedLimit(limit)],
    };
  }

  /** One page of `userId`'s private documents in `coll`, by key: key, record id and version. */
  async function privateVersions(
    appId: string,
    coll: string,
    userId: number,
    afterKey: string,
    limit: number
  ): Promise<PrivateFeedVersion[]> {
    const { ctx, params } = privateFeedParams(appId, coll, userId, afterKey, limit);
    const rows = await withTx(
      ctx,
      async (c) => (await c.query(SQL_PRIVATE_FEED_VERSIONS, params)).rows
    );
    return rows.map((r) => ({
      key: r.key as string,
      recordId: String(r.record_id),
      version: Number(r.version),
      seq: seqOf(r.seq),
    }));
  }

  /** {@link privateVersions} with each document's data. */
  async function privateDocuments(
    appId: string,
    coll: string,
    userId: number,
    afterKey: string,
    limit: number
  ): Promise<PrivateFeedDocument[]> {
    const { ctx, params } = privateFeedParams(appId, coll, userId, afterKey, limit);
    const rows = await withTx(
      ctx,
      async (c) => (await c.query(SQL_PRIVATE_FEED_DOCS, params)).rows
    );
    return rows.map((r) => ({
      key: r.key as string,
      recordId: String(r.record_id),
      version: Number(r.version),
      seq: seqOf(r.seq),
      data: r.data as Record<string, unknown>,
    }));
  }

  return {
    store,
    lookup: { findSharedByKey },
    feed: { feedHead, feedChanges, feedDocuments, feedWitness, levelChanges, levelDocuments },
    // `privateHead` is the public feed's head read: the namespace's newest seq, one counter for
    // every collection of the app, private and shared (`SQL_CHARGE_APP`).
    privateFeed: { privateVersions, privateDocuments, privateHead: feedHead },
    moderation: createModeration({ withTx, charge }),
    rater: createRater({ withTx, charge, raterLookupTx }),
    maintenance: {
      purgeReview,
      listReviewAppIds,
      wipeAccount,
      purgeApp,
      migrateDocuments,
      listMaintRuns,
      purgeDump,
      expireMaintDumps,
    },
    viewerData: { listViewerUsage, viewerHoldings, viewerRecords, emptyViewerData, limits },
  };
}

/**
 * SQLSTATEs that say the server cannot serve this connection: too_many_connections,
 * admin_shutdown, crash_shutdown, cannot_connect_now. Class 08 (connection exception) is
 * matched by prefix in `isPgConnectionFault`, except 08P01 (below).
 */
const PG_CONNECTION_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03']);
/**
 * Node socket errors a broken or unreachable database connection surfaces as. Name-resolution
 * failures (ENOTFOUND, EAI_AGAIN) are deliberately absent: they are a wrong host far more often
 * than a blip, and a retry loop would hide the misconfiguration.
 */
const SOCKET_FAULT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
/**
 * The driver's own connection-loss messages, which carry no code: pg's `Connection terminated`
 * (and `… unexpectedly`, and pg-pool's `… due to connection timeout`), pg-pool's checkout
 * timeout, and pg refusing a query on a client it has already marked broken or closed.
 */
const CONNECTION_FAULT_MESSAGE =
  /^(Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error and is not queryable|Client was closed and is not queryable)/;

/**
 * Whether `err` (or anything on its `cause` chain) says the database connection could not be
 * had or was lost — an availability fault, retryable — as opposed to a fault in what we sent.
 */
function isPgConnectionFault(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === 'object'; depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === 'string') {
      if (code === '08P01') {
        // 08P01 is also Postgres's answer to a malformed message from US, a bug that must stay a
        // 500, so it is retryable only with one of PgBouncer's outage messages. A message not
        // listed in POOLER_TRANSIENT_08P01_MESSAGE is a 500: widen the list when one is seen.
        if (typeof message === 'string' && POOLER_TRANSIENT_08P01_MESSAGE.test(message))
          return true;
      } else if (PG_CONNECTION_SQLSTATES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) {
        // A SQLSTATE is exactly five characters; class 08 is its first two.
        return true;
      }
      if (SOCKET_FAULT_CODES.has(code)) return true;
    }
    if (typeof message === 'string' && CONNECTION_FAULT_MESSAGE.test(message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The retryable refusal for a database the store could not use. Its message names the cause for
 * the store's internal callers, which log `err.message` (the account wipe, review cleanup); the
 * storage route never sends it (`CLIENT_MESSAGE` in `doc-store-api.ts`), and `details` carries
 * only the retry delay. The original is also logged here, because the route's own fault log
 * only ever sees the translated error.
 */
function connectionUnavailable(err: unknown): unknown {
  if (err instanceof DocStoreError) return err;
  const cause = err instanceof Error ? err.message : String(err);
  logToAxiom(
    {
      name: 'app-blocks-doc-store-connection-fault',
      type: 'error',
      error: err instanceof Error ? err.name : typeof err,
      code: (err as { code?: unknown } | null)?.code,
      message: cause,
    },
    'app-blocks'
  );
  return new DocStoreError('service_unavailable', `storage is temporarily unavailable: ${cause}`, {
    retryAfter: 1,
  });
}

/**
 * A connect() rejection that is NOT a connection fault: a wrong password or auth rule (class 28),
 * a missing database (3D000), a host that does not resolve, a pooler refusing a startup
 * parameter, an ended pool. Retrying never helps, so it stays a 500 (rethrown as-is), logged
 * under its own name so a broken deploy is not mistaken for an outage.
 */
function connectConfigFault(err: unknown): unknown {
  logToAxiom(
    {
      name: 'app-blocks-doc-store-config-fault',
      type: 'error',
      error: err instanceof Error ? err.name : typeof err,
      code: (err as { code?: unknown } | null)?.code,
      message: err instanceof Error ? err.message : String(err),
    },
    'app-blocks'
  );
  return err;
}

function translatePgError(err: unknown, opts: { outcomeUnknown?: boolean } = {}): unknown {
  if (err instanceof DocStoreError) return err;
  if (!opts.outcomeUnknown && isPgConnectionFault(err)) return connectionUnavailable(err);
  const e = err as { code?: string; constraint?: string };
  // lock_not_available: waited LOCK_TIMEOUT on a lock (see LOCK_TIMEOUT).
  // Retryable; never park a pooled connection longer.
  if (e && e.code === '55P03') {
    return new DocStoreError('rate_limited', 'storage is busy; retry', {
      reason: 'contention',
      retryAfter: 1,
    });
  }
  if (e && e.code === '23514' && e.constraint === 'doc_size_cap') {
    return new DocStoreError('too_large', `document exceeds ${B.docBytes} bytes`, {
      limit: B.docBytes,
    });
  }
  return err;
}

// ---------------------------------------------------------------------------
// Moderation — session moderators only
// ---------------------------------------------------------------------------
//
// Reachable only through `createDocStoreModeration` — a separate object from the viewer store
// the block-token routes hold — built by `doc-store-moderation.instance.ts` and used by
// `doc-store-moderation.service.ts` behind `moderatorProcedure`. The importer set is pinned by
// `routers/__tests__/apps-mod-doc-store.router.test.ts` (its ledger case).
//
// DISMISSED REPORTS. A moderator who reviews a VISIBLE document and keeps it dismisses its
// reports: `doc.reports_dismissed_at` records when, and only reports made after that point
// count as OPEN (the queue and `reports` below). The report rows themselves are kept. A report is
// one per user AND cannot be withdrawn (the report API has no delete), so a reporter cannot
// re-open a dismissed document by re-filing: only a report from someone who had not reported it
// re-opens it. Deleting the rows instead would let each reporter re-open it after every
// dismissal. Unhide does not touch the point, so it
// re-surfaces no dismissed report; a hidden document is not dismissable (unhide it first), and
// the hidden and all views list hidden documents whatever their open count. The point is the dismissing transaction's start time: a report whose own
// transaction started later is never swept, and one made between the moderator's last look
// and the click is (the revision binding covers the document's content, not its reports).
//
// CROSS-APP WITHOUT A CROSS-APP CONNECTION. Every call here runs in ONE app's
// transaction through the same `withTx` a viewer call uses: the RLS settings are
// bound to that (app, ns), the connection is the same least-privilege role, and every
// statement keeps the `$1`/`$2` isolation shape. Nothing here can name a second app,
// and RLS would hide its rows if anything tried. A cross-app view (the report queue)
// is assembled by the caller from one call per app; there is no superuser or
// BYPASSRLS path.
//
// Moderators act on SHARED documents only (`scope_uid = 0`): reports exist only
// there, and private per-viewer documents are not a moderation surface.

export type ModeratedDocStatus = 'open' | 'hidden' | 'all';

export type ReportedDocRow = {
  collection: string;
  key: string;
  reports: number;
  createdAt: Date;
  updatedAt: Date;
  authorKind: 'user' | 'app';
  /** Moderators may see it; it must never reach an app. */
  authorUid: number | null;
  hiddenAt: Date | null;
  hiddenBy: number | null;
  sizeBytes: number;
  version: number;
  /** The document's revision (`seq`): pass it back to bind an action to exactly this state. */
  revision: number;
};

export type ModeratedDoc = ReportedDocRow & {
  /** When a moderator last dismissed this document's reports; earlier reports are closed. */
  reportsDismissedAt: Date | null;
  /** Every report ever filed on it, dismissed ones included (its `report` rows). */
  reportsTotal: number;
  data: Record<string, unknown>;
  /** md5 of the stored jsonb text — what an audit row records instead of the content. */
  dataMd5: string;
};

type ModerationDeps = {
  withTx: <T>(ctx: DocStoreContext, fn: (c: DocStoreClient) => Promise<T>) => Promise<T>;
  charge: (
    c: DocStoreClient,
    ctx: DocStoreContext,
    app: UsageDelta,
    user: UserCharge
  ) => Promise<number>;
};

// The queue for one (app, ns). Driven by the report rows through `doc_mark_name_idx`
// (app_id, ns, name, …), so its cost follows the app's reports, not its document count:
// documents with at least one OPEN report (made after any dismissal), counted per document.
// $1 app, $2 ns, $3 the report mark name; `statusCond` is a
// fixed string chosen in `listReported`.
const sqlModOpenReported = (statusCond: string) => `SELECT d.coll, d.key, d.author_uid,
    d.author_kind, d.created_at, d.updated_at, d.hidden_at, d.hidden_by, d.size_bytes,
    d.version, d.seq, count(rm.user_id) AS reports
  FROM appdata.doc_mark rm
  JOIN appdata.doc d ON d.app_id = $1 AND d.ns = $2 AND d.coll = rm.coll AND d.scope_uid = 0
    AND d.key = rm.key
  WHERE rm.app_id = $1 AND rm.ns = $2 AND rm.name = $3
    AND (d.reports_dismissed_at IS NULL OR rm.created_at > d.reports_dismissed_at) ${statusCond}
  GROUP BY d.app_id, d.ns, d.coll, d.scope_uid, d.key`;

// The hidden and all views add every HIDDEN document with NO open report (a document hidden
// after its reports were dismissed, or hidden without reports), so it stays reachable for
// unhide or delete. Uses the partial `doc_hidden_idx`, so it reads hidden rows only. $1 app,
// $2 ns, $3 the report mark name.
const SQL_MOD_HIDDEN_UNREPORTED = `SELECT hd.coll, hd.key, hd.author_uid, hd.author_kind,
    hd.created_at, hd.updated_at, hd.hidden_at, hd.hidden_by, hd.size_bytes, hd.version, hd.seq,
    0::bigint AS reports
  FROM appdata.doc hd
  WHERE hd.app_id = $1 AND hd.ns = $2 AND hd.scope_uid = 0 AND hd.hidden_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM appdata.doc_mark hm
      WHERE hm.app_id = $1 AND hm.ns = $2 AND hm.coll = hd.coll AND hm.key = hd.key
        AND hm.name = $3
        AND (hd.reports_dismissed_at IS NULL OR hm.created_at > hd.reports_dismissed_at))`;

/** The page: the branches above, in the queue order, `LIMIT $4`. */
const sqlModReported = (open: string, withHiddenUnreported: boolean) => `SELECT q.* FROM (
  ${open}${withHiddenUnreported ? `\n  UNION ALL\n  ${SQL_MOD_HIDDEN_UNREPORTED}` : ''}
) q
ORDER BY q.reports DESC, q.updated_at DESC, q.coll DESC, q.key DESC
LIMIT $4::int`;

// One shared document as a moderator sees it, hidden or not. $1 app, $2 ns, $3 coll, $4 key
// $5 the report mark name. Reports are counted from their `doc_mark` rows.
const SQL_MOD_GET = `SELECT d.coll, d.key, d.data, md5(d.data::text) AS data_md5, d.version, d.seq, d.size_bytes,
    d.author_uid, d.author_kind, d.created_at, d.updated_at, d.hidden_at, d.hidden_by,
    d.reports_dismissed_at,
    (SELECT count(*) FROM appdata.doc_mark am
      WHERE am.app_id = $1 AND am.ns = $2 AND am.coll = d.coll AND am.key = d.key
        AND am.name = $5) AS reports_total,
    (SELECT count(*) FROM appdata.doc_mark rm
      WHERE rm.app_id = $1 AND rm.ns = $2 AND rm.coll = d.coll AND rm.key = d.key AND rm.name = $5
        AND (d.reports_dismissed_at IS NULL OR rm.created_at > d.reports_dismissed_at)) AS open_reports
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

// Open reports of one shared document. $1 app, $2 ns, $3 coll, $4 key, $5 the report mark name
const SQL_MOD_OPEN_REPORTS = `SELECT count(*) AS n FROM appdata.doc_mark rm
  JOIN appdata.doc d ON d.app_id = $1 AND d.ns = $2 AND d.coll = rm.coll AND d.scope_uid = 0 AND d.key = rm.key
  WHERE rm.app_id = $1 AND rm.ns = $2 AND rm.coll = $3 AND rm.key = $4 AND rm.name = $5
    AND (d.reports_dismissed_at IS NULL OR rm.created_at > d.reports_dismissed_at)`;

// $1 app, $2 ns, $3 coll, $4 key
const SQL_MOD_DISMISS = `UPDATE appdata.doc d SET reports_dismissed_at = now()
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

// $1 app, $2 ns, $3 coll, $4 key, $5 moderator
const SQL_MOD_HIDE = `UPDATE appdata.doc d SET hidden_at = now(), hidden_by = $5::int
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

// Unhiding is a change a feed reader must see again: the doc takes the new seq, which
// is above the hide's tombstone. The tombstone row stays (as it does when a deleted key is
// re-created), so a reader must order a key's doc and tombstone by seq, never treat a
// tombstone's presence alone as "deleted". $1 app, $2 ns, $3 coll, $4 key, $5 seq
const SQL_MOD_UNHIDE = `UPDATE appdata.doc d SET hidden_at = NULL, hidden_by = NULL, seq = $5::bigint
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

// The moderator's lock read: SQL_LOCK_DOC's columns plus `seq`, the revision an action is
// bound to. $1 app, $2 ns, $3 coll, $4 key
const SQL_MOD_LOCK = `SELECT d.version, d.seq, d.author_uid, d.size_bytes, d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
  FOR UPDATE`;

// THE RATER (content levels, build 3; `doc-rater.service.ts`). The shared documents of one
// collection that are not rated for their current version — never rated (NULL), `pending`, or
// rated or overridden for an older version (`RATED_NOW` is false) — oldest change first, after a
// seq cursor. A hidden one waits for a moderator.
// Read server-side to be rated; never returned to a viewer. Uses `doc_feed_shared_seq_idx`.
// $1 app, $2 ns, $3 coll, $4 seq cursor (exclusive), $5 limit
const SQL_RATER_UNRATED = `SELECT d.key, d.data, d.version, d.seq, d.rating_id
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0
    AND d.seq > $4::bigint AND d.hidden_at IS NULL
    AND NOT ${RATED_NOW}
  ORDER BY d.seq
  LIMIT $5::int`;

// The rater's lock read: the revision its rating is bound to. $1 app, $2 ns, $3 coll, $4 key
const SQL_RATER_LOCK = `SELECT d.seq, d.author_kind, d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
  FOR UPDATE`;

// Record a rating for the document's CURRENT version and give it the next seq, so a feed reader
// sees the change. A moderator's override is kept, and wins while it is for this version
// (`CURRENT_LEVEL`). Returns the level readers now get. $1 app, $2 ns, $3 coll, $4 key,
// $5 level, $6 seq
const SQL_RATER_APPLY = `UPDATE appdata.doc d
  SET level = $5::int, rated_version = d.version, rated_at = now(), seq = $6::bigint,
    rating_status = CASE WHEN d.override_level IS NOT NULL AND d.override_version = d.version
      THEN 'overridden' ELSE 'rated' END
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
  RETURNING ${CURRENT_LEVEL} AS current_level`;

// Whether the rating-id migration (`20261118120000_appdata_doc_rating_id.sql`) is applied: its
// lookup policy is on `doc`. Until it is, the rater does nothing (`ready`). A catalog read.
const SQL_RATER_POLICY = `SELECT count(*)::int AS n FROM pg_catalog.pg_policies pp
  WHERE pp.policyname = 'appdata_rater_lookup' AND pp.tablename = 'doc'`;

// The one shared document a rating id names, by address only. Run only inside `raterLookupTx`,
// whose policy admits that one row. $1 rating id
const SQL_RATER_LOOKUP = `SELECT rl.app_id, rl.ns, rl.coll, rl.key FROM appdata.doc rl
  WHERE rl.rating_id = $1::int AND rl.scope_uid = 0`;

// Give a shared document its rating id the first time it is rated; an existing id is kept.
// $1 app, $2 ns, $3 coll, $4 key
const SQL_RATER_ASSIGN_ID = `UPDATE appdata.doc d
  SET rating_id = COALESCE(d.rating_id, nextval('appdata.doc_rating_id_seq')::int)
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
  RETURNING d.rating_id`;

// One shared document as the rater reads it to rate it. Read server-side; never returned to a
// viewer. $1 app, $2 ns, $3 coll, $4 key
const SQL_RATER_GET = `SELECT d.data, d.version, d.seq, d.author_uid, d.author_kind,
    d.hidden_at IS NOT NULL AS hidden, d.rating_id
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4`;

function assertModTarget(collection: string, key: string): void {
  if (!B.collectionName.test(collection)) throw invalid('invalid collection name');
  assertKey(key);
}

/**
 * Refuse, under the row lock, an action on any revision other than the one the moderator saw.
 * The revision is the document's `seq`, not its `version`: `version` restarts at 1 when a key
 * is deleted and re-created, while `seq` is unique per (app, ns) and changes on every document
 * write (and on unhide), so a re-created document can never pass for the one that was reviewed.
 */
function assertModRevision(row: Record<string, unknown>, ifRevision: number | undefined): void {
  if (ifRevision !== undefined && Number(row.seq) !== ifRevision) {
    throw new DocStoreError('version_conflict', 'document changed since it was read', {
      currentVersion: Number(row.version),
    });
  }
}

/**
 * The context a moderator operation runs under. A review namespace belongs to the review
 * itself and is deleted with it (`purgeReview`), so moderation refuses it cleanly
 * (`invalid_request`) rather than reaching it or failing as a malformed context.
 */
function modCtx(appId: string, ns: string): DocStoreContext {
  if (ns.startsWith('rev:')) {
    throw invalid('moderation does not act on review namespaces');
  }
  return { appId, ns, viewerUid: null };
}

/** A shared document already locked FOR UPDATE, as `deleteLockedSharedDocs` needs it. */
type LockedSharedDoc = { coll: string; key: string; sizeBytes: number; authorUid: number | null };

function toLockedSharedDoc(row: Record<string, unknown>): LockedSharedDoc {
  return {
    coll: row.coll as string,
    key: row.key as string,
    sizeBytes: Number(row.size_bytes),
    authorUid:
      row.author_uid === null || row.author_uid === undefined ? null : Number(row.author_uid),
  };
}

/**
 * Hard-delete shared documents the caller has ALREADY locked FOR UPDATE — the one implementation
 * behind the moderator delete and the account wipe. Each document's index rows go with it (FK
 * cascade), its reports are deleted, the app and its author are refunded, and a tombstone takes
 * the next seq: the same accounting as an author delete. Every document and report row is deleted
 * before any usage row is charged (LOCK ORDER (1), then (2), (3)). Returns each document's tombstone seq, in input order.
 */
async function deleteLockedSharedDocs(
  c: DocStoreClient,
  ctx: DocStoreContext,
  charge: ModerationDeps['charge'],
  docs: LockedSharedDoc[]
): Promise<number[]> {
  for (const d of docs) {
    await c.query(SQL_DELETE_DOC, [ctx.appId, ctx.ns, d.coll, 0, d.key]);
    await c.query(SQL_DELETE_MARKS, [ctx.appId, ctx.ns, d.coll, d.key]);
  }
  const seqs: number[] = [];
  for (const d of docs) {
    const seq = await charge(
      c,
      ctx,
      { bytes: -d.sizeBytes, docs: -1 },
      // No user carries a doc without an author uid: an app-authored doc never charged one.
      d.authorUid === null
        ? { uid: 0, bytes: 0, docs: 0, ceiling: 'author' }
        : { uid: d.authorUid, bytes: -d.sizeBytes, docs: -1, ceiling: 'author' }
    );
    await c.query(SQL_TOMBSTONE, [ctx.appId, ctx.ns, d.coll, 0, d.key, seq]);
    seqs.push(seq);
  }
  return seqs;
}

function createModeration({ withTx, charge }: ModerationDeps) {
  /**
   * The first `limit` reported shared documents of ONE app: most reports, then most recently
   * updated, then collection and key (all descending). The caller asks for one more than it
   * keeps, to know whether the app was cut off.
   */
  async function listReported(
    appId: string,
    ns: string,
    opts: { status: ModeratedDocStatus; limit: number }
  ): Promise<ReportedDocRow[]> {
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > B.listLimitMax + 1) {
      throw invalid(`limit must be 1–${B.listLimitMax + 1}`);
    }
    const statusCond =
      opts.status === 'open'
        ? 'AND d.hidden_at IS NULL'
        : opts.status === 'hidden'
        ? 'AND d.hidden_at IS NOT NULL'
        : '';
    // The hidden and all views list every hidden document; the open view needs an open report.
    const sql = sqlModReported(sqlModOpenReported(statusCond), opts.status !== 'open');
    const rows = await withTx(
      modCtx(appId, ns),
      async (c) => (await c.query(sql, [appId, ns, REPORT_MARK, opts.limit])).rows
    );
    return rows.map((r) => ({
      collection: r.coll as string,
      key: r.key as string,
      reports: Number(r.reports),
      createdAt: new Date(r.created_at as string | Date),
      updatedAt: new Date(r.updated_at as string | Date),
      authorKind: r.author_kind as ReportedDocRow['authorKind'],
      authorUid: r.author_uid === null ? null : Number(r.author_uid),
      hiddenAt: r.hidden_at ? new Date(r.hidden_at as string | Date) : null,
      hiddenBy: r.hidden_by === null ? null : Number(r.hidden_by),
      sizeBytes: Number(r.size_bytes),
      version: Number(r.version),
      revision: Number(r.seq),
    }));
  }

  /**
   * One shared document, hidden or not; its reports are `reports` (open) and `reportsTotal` (all time), both counted from the report rows.
   */
  async function get(
    appId: string,
    ns: string,
    collection: string,
    key: string
  ): Promise<ModeratedDoc | null> {
    assertModTarget(collection, key);
    const row = await withTx(
      modCtx(appId, ns),
      async (c) => (await c.query(SQL_MOD_GET, [appId, ns, collection, key, REPORT_MARK])).rows[0]
    );
    if (!row) return null;
    return {
      collection: row.coll as string,
      key: row.key as string,
      data: row.data as Record<string, unknown>,
      dataMd5: row.data_md5 as string,
      // Open reports only; `reportsTotal` is the all-time count.
      reports: Number(row.open_reports),
      reportsTotal: Number(row.reports_total),
      reportsDismissedAt: row.reports_dismissed_at
        ? new Date(row.reports_dismissed_at as string | Date)
        : null,
      createdAt: new Date(row.created_at as string | Date),
      updatedAt: new Date(row.updated_at as string | Date),
      authorKind: row.author_kind as ReportedDocRow['authorKind'],
      authorUid: row.author_uid === null ? null : Number(row.author_uid),
      hiddenAt: row.hidden_at ? new Date(row.hidden_at as string | Date) : null,
      hiddenBy: row.hidden_by === null ? null : Number(row.hidden_by),
      sizeBytes: Number(row.size_bytes),
      version: Number(row.version),
      revision: Number(row.seq),
    };
  }

  /**
   * Hide (or unhide) one shared document. A hidden document reads as not found to the
   * app (`VISIBLE`) and keeps its data, reports and quota charge, so the action
   * is reversible. A hide takes the next seq into a tombstone, so a feed reader drops
   * the document; an unhide gives the document the next seq, so the reader sees it
   * again. Already in the requested state: `changed: false`, nothing written. With
   * `ifRevision`, a document at any other revision (`seq`) is refused (`version_conflict`).
   */
  async function setHidden(
    appId: string,
    ns: string,
    collection: string,
    key: string,
    hidden: boolean,
    moderatorUid: number,
    opts: { ifRevision?: number } = {}
  ): Promise<{ changed: boolean; seq: number | null }> {
    assertModTarget(collection, key);
    if (!(Number.isSafeInteger(moderatorUid) && moderatorUid > 0)) {
      throw new Error('doc-store: malformed moderator id');
    }
    const ctx = modCtx(appId, ns);
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_MOD_LOCK, [appId, ns, collection, key])).rows[0];
      if (!row) throw new DocStoreError('not_found', 'document not found');
      assertModRevision(row, opts.ifRevision);
      if (row.hidden === hidden) return { changed: false, seq: null };
      // No bytes move; the charge only takes the next seq under the usage_app lock (LOCK ORDER (2)).
      const noCharge = { uid: 0, bytes: 0, docs: 0, ceiling: 'app' as const };
      if (hidden) {
        await c.query(SQL_MOD_HIDE, [appId, ns, collection, key, moderatorUid]);
        const seq = await charge(c, ctx, { bytes: 0, docs: 0 }, noCharge);
        await c.query(SQL_TOMBSTONE, [appId, ns, collection, 0, key, seq]);
        return { changed: true, seq };
      }
      const seq = await charge(c, ctx, { bytes: 0, docs: 0 }, noCharge);
      await c.query(SQL_MOD_UNHIDE, [appId, ns, collection, key, seq]);
      return { changed: true, seq };
    });
  }

  /**
   * Dismiss the document's open reports (it was reviewed and kept): later reports open it
   * again. Bound to the revision like the other actions. Returns how many were open.
   */
  async function dismissReports(
    appId: string,
    ns: string,
    collection: string,
    key: string,
    opts: { ifRevision?: number } = {}
  ): Promise<{ dismissed: number }> {
    assertModTarget(collection, key);
    return withTx(modCtx(appId, ns), async (c) => {
      const row = (await c.query(SQL_MOD_LOCK, [appId, ns, collection, key])).rows[0];
      if (!row) throw new DocStoreError('not_found', 'document not found');
      assertModRevision(row, opts.ifRevision);
      if (row.hidden) {
        throw invalid('a hidden document is not dismissable; unhide it first');
      }
      const open = await c.query(SQL_MOD_OPEN_REPORTS, [appId, ns, collection, key, REPORT_MARK]);
      await c.query(SQL_MOD_DISMISS, [appId, ns, collection, key]);
      return { dismissed: Number(open.rows[0]?.n ?? 0) };
    });
  }

  /**
   * Hard-delete one shared document, hidden or not: its index rows go with it (FK
   * cascade), its reports are deleted, the app and its author are refunded, and a tombstone
   * takes the next seq — the same accounting as an author delete. A document with no
   * `author_uid` (app-authored) refunds the app only: no user carries it.
   */
  async function remove(
    appId: string,
    ns: string,
    collection: string,
    key: string,
    opts: { ifRevision?: number } = {}
  ): Promise<{ deleted: true; sizeBytes: number; seq: number }> {
    assertModTarget(collection, key);
    const ctx = modCtx(appId, ns);
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_MOD_LOCK, [appId, ns, collection, key])).rows[0];
      if (!row) throw new DocStoreError('not_found', 'document not found');
      assertModRevision(row, opts.ifRevision);
      const doc = toLockedSharedDoc({ ...row, coll: collection, key });
      const [seq] = await deleteLockedSharedDocs(c, ctx, charge, [doc]);
      return { deleted: true as const, sizeBytes: doc.sizeBytes, seq };
    });
  }

  return { listReported, get, setHidden, dismissReports, delete: remove };
}

/** A shared document waiting for a rating, as the rater reads it. */
export type UnratedDoc = {
  key: string;
  data: unknown;
  version: number;
  /** The revision a rating of this read is bound to (`applyRating`'s `seq`). */
  seq: number;
  /** Its rating id, once the rater has given it one. */
  ratingId: number | null;
};

export type ApplyRatingResult =
  | { applied: true; seq: number; currentLevel: number }
  | { applied: false; reason: 'gone' | 'changed' | 'hidden' };

/** The levels a rating may carry: one NsfwLevel bit (the CHECK `doc_level_bit`). */
const RATING_LEVEL_BITS = new Set([1, 2, 4, 8, 16, 32]);

/** A shared document's address: what a rating id names. */
export type RatedDocAddress = { appId: string; ns: string; collection: string; key: string };

/** One shared document as the rater reads it. */
export type DocForRating = {
  data: unknown;
  version: number;
  /** The revision a rating of this read is bound to (`applyRating`'s `seq`). */
  seq: number;
  authorUid: number | null;
  authorKind: string;
  hidden: boolean;
  ratingId: number | null;
};

const MAX_RATING_ID = 2_147_483_647;

function createRater({
  withTx,
  charge,
  raterLookupTx,
}: ModerationDeps & {
  raterLookupTx: <T>(ratingId: number, fn: (c: DocStoreClient) => Promise<T>) => Promise<T>;
}) {
  let migrated = false;

  /**
   * Whether the rating-id migration is applied (its lookup policy exists). Found once and kept;
   * while absent, asked again on every call, which is once per rater pass.
   */
  async function ready(): Promise<boolean> {
    if (migrated) return true;
    const n = await raterLookupTx(0, async (c) =>
      Number((await c.query(SQL_RATER_POLICY)).rows[0]?.n ?? 0)
    );
    migrated = n > 0;
    return migrated;
  }

  /** The shared document `ratingId` names, or null when no document carries it any more. */
  async function findByRatingId(ratingId: number): Promise<RatedDocAddress | null> {
    if (!Number.isSafeInteger(ratingId) || ratingId < 1 || ratingId > MAX_RATING_ID) return null;
    const row = await raterLookupTx(
      ratingId,
      async (c) => (await c.query(SQL_RATER_LOOKUP, [ratingId])).rows[0]
    );
    if (!row) return null;
    return {
      appId: row.app_id as string,
      ns: row.ns as string,
      collection: row.coll as string,
      key: row.key as string,
    };
  }

  /** The shared document's rating id, given on first use; null when the document is gone. */
  async function assignRatingId(
    appId: string,
    ns: string,
    collection: string,
    key: string
  ): Promise<number | null> {
    assertModTarget(collection, key);
    const row = await withTx(
      { appId, ns, viewerUid: null },
      async (c) => (await c.query(SQL_RATER_ASSIGN_ID, [appId, ns, collection, key])).rows[0]
    );
    return row ? Number(row.rating_id) : null;
  }

  /** One shared document as the rater rates it, or null when it is gone. */
  async function getForRating(
    appId: string,
    ns: string,
    collection: string,
    key: string
  ): Promise<DocForRating | null> {
    assertModTarget(collection, key);
    const row = await withTx(
      { appId, ns, viewerUid: null },
      async (c) => (await c.query(SQL_RATER_GET, [appId, ns, collection, key])).rows[0]
    );
    if (!row) return null;
    return {
      data: row.data,
      version: Number(row.version),
      seq: Number(row.seq),
      authorUid: row.author_uid === null ? null : Number(row.author_uid),
      authorKind: row.author_kind as string,
      hidden: row.hidden === true,
      ratingId: row.rating_id === null ? null : Number(row.rating_id),
    };
  }
  /**
   * Up to `limit` shared documents of one collection that need a rating, oldest change first,
   * after the seq cursor `afterSeq` (exclusive; 0 from the start).
   */
  async function listUnrated(
    appId: string,
    ns: string,
    collection: string,
    opts: { afterSeq: number; limit: number }
  ): Promise<UnratedDoc[]> {
    if (!B.collectionName.test(collection)) throw invalid('invalid collection name');
    if (!Number.isSafeInteger(opts.afterSeq) || opts.afterSeq < 0) {
      throw invalid('afterSeq must be a non-negative integer');
    }
    if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > B.listLimitMax) {
      throw invalid(`limit must be 1–${B.listLimitMax}`);
    }
    const rows = await withTx(
      { appId, ns, viewerUid: null },
      async (c) =>
        (
          await c.query(SQL_RATER_UNRATED, [appId, ns, collection, opts.afterSeq, opts.limit])
        ).rows
    );
    return rows.map((r) => ({
      key: r.key as string,
      data: r.data,
      version: Number(r.version),
      seq: Number(r.seq),
      ratingId: r.rating_id === null || r.rating_id === undefined ? null : Number(r.rating_id),
    }));
  }

  /**
   * Record `level` as the rating of the shared document `key` — only if it is still at the
   * revision `seq` the rater read and scanned. Any write since (an edit, a delete and re-create, a
   * schema migration) moved its seq, so the rating is dropped (`changed`) and the document stays
   * pending for the next pass; `version` alone cannot tell, as it restarts at 1 on a re-create. The
   * rating is recorded for the document's current version, takes the next seq (a feed reader sees
   * it), and a moderator's override for this version still wins.
   */
  async function applyRating(
    appId: string,
    ns: string,
    collection: string,
    key: string,
    opts: { seq: number; level: number }
  ): Promise<ApplyRatingResult> {
    assertModTarget(collection, key);
    if (!RATING_LEVEL_BITS.has(opts.level)) throw invalid('level must be one NsfwLevel bit');
    if (!Number.isSafeInteger(opts.seq) || opts.seq < 1) throw invalid('malformed seq');
    const ctx: DocStoreContext = { appId, ns, viewerUid: null };
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_RATER_LOCK, [appId, ns, collection, key])).rows[0];
      if (!row) return { applied: false, reason: 'gone' } as const;
      if (Number(row.seq) !== opts.seq) return { applied: false, reason: 'changed' } as const;
      if (row.hidden) return { applied: false, reason: 'hidden' } as const;
      // No bytes move; the charge only takes the next seq under the usage_app lock (LOCK ORDER (2)).
      const seq = await charge(c, ctx, NO_APP_CHARGE, {
        uid: 0,
        bytes: 0,
        docs: 0,
        ceiling: 'app',
      });
      const out = await c.query(SQL_RATER_APPLY, [appId, ns, collection, key, opts.level, seq]);
      return { applied: true, seq, currentLevel: Number(out.rows[0].current_level) } as const;
    });
  }

  return { ready, findByRatingId, assignRatingId, getForRating, listUnrated, applyRating };
}
