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
// There are TWO exceptions. The first is review maintenance (`purgeReview`, `listReviewAppIds`):
// statements keyed on `app_id = $1 AND ns LIKE 'rev:%'` (the listing: `ns LIKE 'rev:%'`
// on `usage_app` and `doc`), run only inside `maintenanceTx`, whose transaction-local
// `appdata.review_maintenance` setting is what the migration's review policies
// admit — review namespaces only, read and delete only.
//
// The other exception is the ACCOUNT WIPE's enumeration (`listAccountNamespaces`): one
// SELECT keyed on `user_id = $1` over `usage_user` and `doc_mark`, run only inside
// `accountWipeTx`, whose transaction-local `appdata.account_wipe_uid` setting the
// migration's wipe policy admits for that ONE user's rows of those two tables, read only.
// It returns (app, ns) pairs; the wipe of each runs in an ordinary `withTx`, keyed and
// scoped like any viewer call.
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
//     delete, increment, mark, unmark);
//   - rate limits;
//   - content moderation of shared writes;
//   - a collection's `ownedModelVersions` rule on create and put (`doc-store-ownership.ts`);
//   - map `DocStoreError` codes to HTTP statuses and envelopes;
//   - resolve `author.uid` to a username (and never forward the uid).
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
// author changes a shared doc, a private doc is the viewer's, and a counter
// collection's doc is charged to the viewer whose increment created it.
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
// one key being written, (1b) that document's tally and mark rows, (2)
// `usage_app` for (app, ns), (3) the caller's `usage_user` row. Nothing takes a
// document or tally lock after (2), and (3) is only taken holding (2), so no
// cycle can form. Incrementing an EXISTING document and marking take only a KEY
// SHARE lock on the document and the tally row, and no usage lock.
//
// `seq` comes from `usage_app.last_seq`, incremented in the same statement that
// charges the quota and therefore row-locked until commit: per-(app, ns) seq
// order equals commit order, which is what a future change-feed poller needs.

import { escapeLiteral } from 'pg';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { newUlid } from '~/server/utils/app-block-ids';
import type {
  AccountWipeNamespaceResult,
  AccountWipeResult,
  DocCollection,
  DocIndexType,
  DocListQuery,
  DocListResult,
  DocRecord,
  DocStoreContext,
  DocStoreLimits,
  DocStoreUsage,
  QuotaCeiling,
} from '~/server/services/apps/doc-store.types';
import {
  DEFAULT_DOC_STORE_LIMITS,
  DOC_STORE_BOUNDS as B,
  DocStoreError,
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
  /** Called once, the first time the connected role is found to be superuser or BYPASSRLS. */
  onRefused?: (role: { name: string; superuser: boolean; bypassRls: boolean }) => void;
  /**
   * Test-only seam: awaited after a write's document change and before its
   * usage charge — the exact window a pre-flight-read quota would race in. The
   * concurrency test parks every writer here so they all reach the charge
   * together. Never set in production.
   */
  hooks?: { beforeUsageCharge?: () => Promise<void> };
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
const TALLY_NAME_SHAPE = /^[a-z][a-z0-9_]{0,31}$/;
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
      'documents in this collection are written by counters only'
    );
  }
}

/**
 * A report cannot be withdrawn. Withdrawing and re-filing would otherwise make a fresh report
 * after a moderator dismissed the document's reports, so one viewer could re-open it
 * indefinitely (see DISMISSED REPORTS in the moderation section). Exported so the route refuses
 * it before spending any budget or reading the viewer's trust; the store runs it on every
 * `unmark` itself.
 */
export function refuseReportWithdrawal(name: string): void {
  if (name === REPORT_MARK) throw invalid('a report cannot be withdrawn', { mark: name });
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

/** Document columns plus its tallies and the viewer's own marks. `viewerParam` is a placeholder. */
function docColumns(viewerParam: string): string {
  return `d.key, d.data, d.version, d.created_at, d.updated_at, d.author_uid, d.author_kind,
    (SELECT jsonb_object_agg(t.kind || ':' || t.name, t.count) FROM appdata.doc_tally t
      WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = d.coll AND t.key = d.key AND d.scope_uid = 0) AS tallies,
    (SELECT array_agg(vm.name ORDER BY vm.name) FROM appdata.doc_mark vm
      WHERE vm.app_id = $1 AND vm.ns = $2 AND vm.coll = d.coll AND vm.key = d.key
        AND vm.user_id = ${viewerParam} AND d.scope_uid = 0) AS viewer_marks`;
}

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

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 viewer, $6 keys
const SQL_GET_MANY = `SELECT ${docColumns('$5::int')}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.key = ANY($6::text[]) AND ${VISIBLE}`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_LOCK_DOC = `SELECT d.version, d.author_uid, d.author_kind, d.size_bytes,
    d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  FOR UPDATE`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid
const SQL_INSERT_DOC = `INSERT INTO appdata.doc AS d
    (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid)
  VALUES ($1, $2, $3, $4::int, $5, $6::jsonb, 1, 0, $7::int, 'user', $7::int)
  ON CONFLICT DO NOTHING
  RETURNING d.size_bytes`;

// A document in a `write: 'none'` collection, created by the first increment of
// one of its counters: empty data and author_kind 'counter'. `author_uid` records
// the incrementer ONLY so the creation is charged to their per-user ceiling like
// any other create; it confers nothing — `author=me` and the `own` policy both
// require author_kind 'user', and readers see `{ kind: 'counter' }` with no uid.
// $1 app, $2 ns, $3 coll, $4 key, $5 incrementer
const SQL_INSERT_COUNTER_DOC = `INSERT INTO appdata.doc AS d
    (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid)
  VALUES ($1, $2, $3, 0, $4, '{}'::jsonb, 1, 0, $5::int, 'counter', $5::int)
  ON CONFLICT DO NOTHING
  RETURNING d.size_bytes`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid
const SQL_UPDATE_DOC = `UPDATE appdata.doc d
  SET data = $6::jsonb, version = d.version + 1, last_writer_uid = $7::int, updated_at = now()
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING d.size_bytes`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_DELETE_DOC = `DELETE FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5`;

// A deleted shared document's tallies and marks ($1 app, $2 ns, $3 coll, $4 key).
const SQL_DELETE_TALLIES = `DELETE FROM appdata.doc_tally t
  WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = $3 AND t.key = $4`;
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

// Stamp the seq and return the stored document.
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 seq, $7 viewer
const SQL_STAMP_SEQ = `UPDATE appdata.doc d SET seq = $6::bigint
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  RETURNING ${docColumns('$7::int')}`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 seq
const SQL_TOMBSTONE = `INSERT INTO appdata.doc_tomb AS tb (app_id, ns, coll, scope_uid, key, seq)
  VALUES ($1, $2, $3, $4::int, $5, $6::bigint)
  ON CONFLICT (app_id, ns, coll, scope_uid, key)
  DO UPDATE SET seq = EXCLUDED.seq, deleted_at = now()`;

// Counters and marks: shared documents only. KEY SHARE blocks a concurrent
// delete of the document until this transaction ends, without blocking other
// counter/mark writers. $1 app, $2 ns, $3 coll, $4 key
const SQL_SHARE_LOCK_DOC = `SELECT 1 AS ok FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = 0 AND d.key = $4
    AND ${VISIBLE}
  FOR KEY SHARE`;

// Server-side lookup of one key across the app's SHARED collections. Hidden rows included, so
// the caller can tell hidden from missing. LIMIT 2 is enough to tell one match from several.
// Only a user-authored document has an author here: a counter document's `author_uid` is
// whoever incremented it first, which is not authorship. $1 app, $2 ns, $3 collection names,
// $4 key
const SQL_LOOKUP_SHARED_KEY = `SELECT d.coll,
    CASE WHEN d.author_kind = 'user' THEN d.author_uid END AS author_uid,
    d.hidden_at IS NOT NULL AS hidden
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = ANY($3::text[]) AND d.scope_uid = 0
    AND d.key = $4
  ORDER BY d.coll
  LIMIT 2`;

// The kind is a literal: this statement can only ever write a counter row.
// $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 by
const SQL_INCREMENT = `INSERT INTO appdata.doc_tally AS t (app_id, ns, coll, key, kind, name, count)
  VALUES ($1, $2, $3, $4, 'counter', $5, $6::bigint)
  ON CONFLICT (app_id, ns, coll, key, kind, name) DO UPDATE SET count = t.count + EXCLUDED.count
  RETURNING t.count`;

// A mark carries no payload: `report` is a mark like any other. (The table's nullable
// `reason` column is never written.) $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 user
const SQL_INSERT_MARK = `INSERT INTO appdata.doc_mark AS mk (app_id, ns, coll, key, name, user_id)
  VALUES ($1, $2, $3, $4, $5, $6::int)
  ON CONFLICT DO NOTHING
  RETURNING 1 AS inserted`;

// $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 user
const SQL_DELETE_MARK = `DELETE FROM appdata.doc_mark mk
  WHERE mk.app_id = $1 AND mk.ns = $2 AND mk.coll = $3 AND mk.key = $4 AND mk.name = $5 AND mk.user_id = $6::int
  RETURNING 1 AS deleted`;

// $1 app, $2 ns, $3 coll, $4 key, $5 name
const SQL_MARK_UP = `INSERT INTO appdata.doc_tally AS t (app_id, ns, coll, key, kind, name, count)
  VALUES ($1, $2, $3, $4, 'mark', $5, 1)
  ON CONFLICT (app_id, ns, coll, key, kind, name) DO UPDATE SET count = t.count + 1
  RETURNING t.count`;
const SQL_MARK_DOWN = `UPDATE appdata.doc_tally t SET count = t.count - 1
  WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = $3 AND t.key = $4 AND t.kind = 'mark' AND t.name = $5
  RETURNING t.count`;
const SQL_MARK_COUNT = `SELECT t.count FROM appdata.doc_tally t
  WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = $3 AND t.key = $4 AND t.kind = 'mark' AND t.name = $5`;

// Stored usage. $1 app, $2 ns (+ $3 user). A missing row is zero.
const SQL_USAGE_APP = `SELECT u.bytes, u.docs FROM appdata.usage_app u
  WHERE u.app_id = $1 AND u.ns = $2`;
const SQL_USAGE_USER = `SELECT u.bytes, u.docs FROM appdata.usage_user u
  WHERE u.app_id = $1 AND u.ns = $2 AND u.user_id = $3::int`;

// Review maintenance (see the module header). Every row of every review namespace of one
// publish request, table by table, in the store's lock order (document first — its index rows
// go with it by the foreign-key cascade — then tallies and marks, then usage_app before
// usage_user), so a write racing the purge cannot deadlock against it. $1 publish request id.
// Each returns the number of rows it deleted.
const SQL_REVIEW_PURGE = [
  `WITH gone AS (DELETE FROM appdata.doc d WHERE d.app_id = $1 AND d.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_index ix WHERE ix.app_id = $1 AND ix.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tally t WHERE t.app_id = $1 AND t.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tomb tb WHERE tb.app_id = $1 AND tb.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_user u WHERE u.app_id = $1 AND u.ns LIKE 'rev:%' RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
] as const;

// The publish requests that still have review data, in id order after a keyset cursor. From
// `usage_app` AND `doc`: a document inserted by a write that overlapped a purge can commit
// after the purge deleted its namespace's `usage_app` row, leaving a document with no usage
// row; tallies, marks and index rows exist only beside a document, and a tombstone's write
// holds the document's lock, which the purge waits for. $1 cursor (exclusive), $2 limit.
const SQL_REVIEW_APP_IDS = `SELECT r.app_id FROM (
    SELECT u.app_id FROM appdata.usage_app u WHERE u.ns LIKE 'rev:%' AND u.app_id > $1
    UNION
    SELECT d.app_id FROM appdata.doc d WHERE d.ns LIKE 'rev:%' AND d.app_id > $1
  ) r ORDER BY r.app_id LIMIT $2::int`;

// ACCOUNT WIPE (see the module header and `wipeAccount`).
//
// The (app, ns) pairs in which one user has rows that name them, in key order after a keyset
// cursor. Two sources suffice: every document that names a user — their private documents, the
// shared documents they authored, the counter documents whose creation was charged to them — is
// charged to that user's `usage_user` row in the same transaction that writes it (the invariant
// `assertUsageConsistent` checks in every suite), and a mark names its user in `doc_mark`. Run
// only inside `accountWipeTx`. $1 user id, $2 app id and $3 ns of the cursor (exclusive), $4 limit.
const SQL_ACCOUNT_NAMESPACES = `SELECT w.app_id, w.ns FROM (
    SELECT wu.app_id, wu.ns FROM appdata.usage_user wu WHERE wu.user_id = $1::int
    UNION
    SELECT wm.app_id, wm.ns FROM appdata.doc_mark wm WHERE wm.user_id = $1::int
  ) w WHERE (w.app_id, w.ns) > ($2::text, $3::text)
  ORDER BY w.app_id, w.ns LIMIT $4::int`;

// The wipe of ONE (app, ns), in an ordinary scoped transaction. $1 app, $2 ns, $3 user id.
// Statement order follows the store's LOCK ORDER: document rows, then tally and mark rows, then
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
  `WITH gone AS (DELETE FROM appdata.doc_tally t WHERE t.app_id = $1 AND t.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_mark mk WHERE mk.app_id = $1 AND mk.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.doc_tomb tb WHERE tb.app_id = $1 AND tb.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_app u WHERE u.app_id = $1 AND u.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
  `WITH gone AS (DELETE FROM appdata.usage_user u WHERE u.app_id = $1 AND u.ns = $2 RETURNING 1)
  SELECT count(*)::int AS n FROM gone`,
] as const;

// Any other namespace (`prod`, a review namespace): only what names the user.
// The user's private documents; their index rows go by the cascade. Private documents have no
// tallies or marks, and get no tombstone: the only reader of a private key space is its owner.
const SQL_WIPE_PRIVATE_DOCS = `WITH gone AS (DELETE FROM appdata.doc d
    WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = $3::int RETURNING d.size_bytes)
  SELECT count(*)::int AS docs, COALESCE(sum(gone.size_bytes), 0)::bigint AS bytes FROM gone`;
// EVERY shared document the wipe will touch in this namespace — the ones the user authored
// (hidden or not), which it deletes; the counter documents whose creation was charged to the
// user, whose uid it clears; and the ones the user marked, whose tallies it decrements — locked
// in ONE statement, in (coll, key) order. Two wipes of users who authored and marked each
// other's documents then queue on the first document they share instead of each holding its own
// author's documents and waiting for the other's: with the authored set and the marked set
// locked by separate statements, that deadlocked every time on a real server.
// FOR UPDATE for both sets: the authored ones are deleted, which needs it, and a single statement
// has a single strength. Taking a weaker lock on the marked ones would need a second statement
// (or an upgrade later), which is the interleaving this exists to remove. The cost: a viewer
// marking or incrementing one of those documents waits for the wipe to commit (bounded by
// LOCK_TIMEOUT).
// After this statement, the only document rows the wipe writes are (a) shared documents in this
// lock set — deleted by `deleteLockedSharedDocs` (authored), uid-cleared by
// `SQL_WIPE_RELEASE_COUNTER_DOCS` (counter) — and (b) the user's own PRIVATE documents
// (`SQL_WIPE_PRIVATE_DOCS`, `scope_uid` = the user), which no other wipe ever locks: every other
// wipe's lock set is shared documents only. Every tally and mark row it changes belongs to a
// document in this set, except a document the user's own in-flight write commits between
// statements, which the second pass locks. (Leaving the counter documents out of this set deadlocked two wipes of
// users who had reported each other's counter documents.) `authored` marks the documents to
// delete: user-authored only, never a counter document, which outlives its creator; the same
// delete path a moderator delete takes.
const SQL_WIPE_LOCK_DOCS = `SELECT d.coll, d.key, d.size_bytes, d.author_uid,
    (d.author_kind = 'user' AND d.author_uid = $3::int) AS authored
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = 0
    AND ((d.author_kind IN ('user', 'counter') AND d.author_uid = $3::int)
      OR EXISTS (SELECT 1 FROM appdata.doc_mark lm
        WHERE lm.app_id = $1 AND lm.ns = $2 AND lm.coll = d.coll AND lm.key = d.key
          AND lm.user_id = $3::int))
  ORDER BY d.coll, d.key
  FOR UPDATE OF d`;
// Counter-created documents whose creation was charged to the user: the uid was kept ONLY for
// that charge, and the charge is released with the user's usage rows below, so the uid goes too.
const SQL_WIPE_RELEASE_COUNTER_DOCS = `WITH done AS (UPDATE appdata.doc d
    SET author_uid = NULL, last_writer_uid = NULL
    WHERE d.app_id = $1 AND d.ns = $2 AND d.scope_uid = 0 AND d.author_kind = 'counter'
      AND d.author_uid = $3::int
    RETURNING 1)
  SELECT count(*)::int AS n FROM done`;
// The user's marks, reports included, and the same statement takes each from its tally: the
// two can never disagree. A tally already below its marks (drift; the reconciler's to report)
// stops at 0 rather than failing the wipe on the `doc_tally_nonnegative` CHECK.
const SQL_WIPE_MARKS = `WITH gone AS (DELETE FROM appdata.doc_mark mk
    WHERE mk.app_id = $1 AND mk.ns = $2 AND mk.user_id = $3::int
    RETURNING mk.coll, mk.key, mk.name),
  per AS (SELECT g.coll, g.key, g.name, count(*)::bigint AS n FROM gone g
    GROUP BY g.coll, g.key, g.name),
  down AS (UPDATE appdata.doc_tally t SET count = GREATEST(t.count - per.n, 0)
    FROM per
    WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = per.coll AND t.key = per.key
      AND t.kind = 'mark' AND t.name = per.name
    RETURNING 1)
  SELECT (SELECT count(*) FROM gone)::int AS marks`;
// Tombstones of the user's private documents carry their uid as `scope_uid`. After `usage_app`,
// where every writer of a tombstone takes it.
const SQL_WIPE_PRIVATE_TOMBS = `DELETE FROM appdata.doc_tomb tb
  WHERE tb.app_id = $1 AND tb.ns = $2 AND tb.scope_uid = $3::int`;
// The user's usage row: every byte it counted is gone (deleted documents) or released (counter
// documents now charge no user).
const SQL_WIPE_USAGE_USER = `DELETE FROM appdata.usage_user u
  WHERE u.app_id = $1 AND u.ns = $2 AND u.user_id = $3::int`;

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
// LEFT JOIN + COALESCE: a document with no tally row sorts as 0. That ordering
// cannot come from `doc_tally_top_idx`, so a tally sort reads the collection and
// sorts it; serving it from the index would need a zero row per declared tally
// per document (a backfill whenever a counter or mark is declared).
const listSortTallyJoin = (kind: string, name: string) => `LEFT JOIN appdata.doc_tally st
    ON st.app_id = $1 AND st.ns = $2 AND st.coll = d.coll AND st.key = d.key
    AND st.kind = ${kind} AND st.name = ${name}`;
const listMarkedByMe = (name: string, user: string) => `EXISTS (SELECT 1 FROM appdata.doc_mark mb
    WHERE mb.app_id = $1 AND mb.ns = $2 AND mb.coll = d.coll AND mb.key = d.key
      AND mb.name = ${name} AND mb.user_id = ${user})`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function toDocRecord(
  row: Record<string, unknown>,
  ctx: DocStoreContext,
  coll: DocCollection
): DocRecord {
  const tallies = (row.tallies ?? {}) as Record<string, number | string>;
  const counters: Record<string, number> = {};
  const marks: Record<string, number> = {};
  if (coll.config.visibility === 'shared') {
    for (const name of coll.config.counters ?? []) counters[name] = 0;
    for (const name of coll.config.marks ?? []) if (name !== REPORT_MARK) marks[name] = 0;
    for (const [k, v] of Object.entries(tallies)) {
      const sep = k.indexOf(':');
      const kind = k.slice(0, sep);
      const name = k.slice(sep + 1);
      // A report count is never exposed to anyone.
      if (kind === 'counter') counters[name] = Number(v);
      else if (kind === 'mark' && name !== REPORT_MARK) marks[name] = Number(v);
    }
  }
  const authorUid = row.author_uid === null ? null : Number(row.author_uid);
  return {
    key: row.key as string,
    data: row.data as Record<string, unknown>,
    version: Number(row.version),
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
    author:
      row.author_kind === 'counter'
        ? { kind: 'counter' }
        : row.author_kind === 'app' || authorUid === null
        ? { kind: 'app' }
        : { kind: 'user', uid: authorUid, isViewer: authorUid === ctx.viewerUid },
    counters,
    marks,
    viewer:
      ctx.viewerUid === null
        ? null
        : { marks: ((row.viewer_marks as string[] | null) ?? []).slice() },
  };
}

// ---------------------------------------------------------------------------
// List: sort and cursor
// ---------------------------------------------------------------------------

type SortSpec =
  | { kind: 'key'; desc: boolean }
  | { kind: 'createdAt' | 'updatedAt'; desc: boolean }
  | { kind: 'index'; desc: boolean; name: string; type: DocIndexType }
  | { kind: 'tally'; desc: boolean; tally: 'counter' | 'mark'; name: string };

function parseSort(coll: DocCollection, raw: string | undefined): SortSpec {
  const s = raw ?? 'key';
  const desc = s.startsWith('-');
  const field = desc ? s.slice(1) : s;
  if (field === 'key') return { kind: 'key', desc };
  if (field === 'createdAt' || field === 'updatedAt') return { kind: field, desc };
  const tally = /^(counter|mark):(.+)$/.exec(field);
  if (tally) {
    requireShared(coll, 'counters and marks');
    const kind = tally[1] as 'counter' | 'mark';
    const name = tally[2];
    const declared = kind === 'counter' ? coll.config.counters ?? [] : coll.config.marks ?? [];
    // A report count is never exposed, so it is never a sort key — even if declared.
    if (!declared.includes(name) || (kind === 'mark' && name === REPORT_MARK)) {
      throw new DocStoreError('index_not_declared', `${kind} ${name} is not declared`, {
        field,
      });
    }
    return { kind: 'tally', desc, tally: kind, name };
  }
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
    case 'tally':
      return `t${dir}`;
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
    // Microseconds since epoch (17 digits reach year 5138) or a tally count (never
    // negative; 18 digits stay under the bigint maximum). Anything else would be a
    // 500 from the cast or the interval arithmetic.
    const digits = sort.kind === 'tally' ? 18 : 17;
    if (!new RegExp(`^[0-9]{1,${digits}}$`).test(payload)) throw bad();
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
 * MAINTENANCE — review-namespace deletion (`purgeReview`, `listReviewAppIds`) and account
 * deletion (`wipeAccount`) — as a separate object from the viewer store: the first runs with the
 * setting that reaches every `rev:` row of a request, the second with the one that reads one
 * user's rows in every app, so nothing holding the block-token routes' store may reach either.
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

/** The production namespace: published data, never a developer's dev or a moderator's review namespace. */
export const PUBLISHED_NS = 'prod';

/** One shared document matched by `findSharedByKey`. */
export type SharedKeyMatch = {
  collection: string;
  /** Null for a document no user authored (an `app` or `counter` document). */
  authorUid: number | null;
  hidden: boolean;
};

function buildDocStore(deps: DocStoreDeps) {
  const limits = deps.limits ?? DEFAULT_DOC_STORE_LIMITS;
  // Settled only by a successful role read; a failed read is retried next call.
  let privileges: 'safe' | 'refused' | undefined;

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
   * every other setting. 🔴 Called by `listAccountNamespaces` ONLY (pinned by
   * `doc-store.sql-isolation.test.ts`).
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

  /** Charge one write: `usage_app` (which also yields the seq), then the caller's `usage_user`. */
  async function charge(
    c: DocStoreClient,
    ctx: DocStoreContext,
    app: UsageDelta,
    user: UserCharge
  ): Promise<number> {
    await deps.hooks?.beforeUsageCharge?.();
    const appRes = await c.query(SQL_CHARGE_APP, [
      ctx.appId,
      ctx.ns,
      app.bytes,
      app.docs,
      limits.appBytes,
      limits.appDocs,
    ]);
    if (appRes.rows.length === 0) {
      throw new DocStoreError('quota_exceeded', 'app storage quota exceeded', { ceiling: 'app' });
    }
    if (user.bytes !== 0 || user.docs !== 0) {
      const res = await c.query(SQL_CHARGE_USER, [
        ctx.appId,
        ctx.ns,
        user.uid,
        user.bytes,
        user.docs,
        limits.userBytes,
        limits.userDocs,
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
    opts: { ifVersion?: number }
  ): Promise<DocRecord> {
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
    const indexRows = indexRowsFor(coll, data as Record<string, unknown>);
    const scope = scopeUid(ctx, coll);
    const base = [ctx.appId, ctx.ns, coll.name, scope, key];

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
          if (opts.ifVersion !== undefined && opts.ifVersion !== current) {
            throw new DocStoreError('version_conflict', 'version conflict', {
              currentVersion: current,
            });
          }
          assertMayModify(ctx, coll, existing);
          const res = await c.query(SQL_UPDATE_DOC, [...base, json, viewer]);
          const delta = Number(res.rows[0].size_bytes) - Number(existing.size_bytes);
          return finishWrite(c, ctx, coll, scope, key, indexRows, {
            app: appDelta(scope, { bytes: delta, docs: 0 }),
            user: { uid: viewer, bytes: delta, docs: 0, ceiling: ceilingFor(coll) },
          });
        }

        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: 0 });
        }
        const ins = await c.query(SQL_INSERT_DOC, [...base, json, viewer]);
        if (ins.rows.length === 0) continue; // lost the race; re-read
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

  async function finishWrite(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    scope: number,
    key: string,
    indexRows: IndexRow[],
    usage: { app: UsageDelta; user: UserCharge }
  ): Promise<DocRecord> {
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
    const res = await c.query(SQL_STAMP_SEQ, [
      ctx.appId,
      ctx.ns,
      coll.name,
      scope,
      key,
      seq,
      ctx.viewerUid,
    ]);
    return toDocRecord(res.rows[0], ctx, coll);
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
    const rows = await withTx(
      ctx,
      async (c) =>
        (
          await c.query(SQL_GET_MANY, [
            ctx.appId,
            ctx.ns,
            coll.name,
            scope,
            ctx.viewerUid,
            [...new Set(keys)],
          ])
        ).rows
    );
    const byKey = new Map(rows.map((r) => [r.key as string, toDocRecord(r, ctx, coll)]));
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
    opts: { ifVersion?: number } = {}
  ): Promise<DocRecord> {
    return writeDoc(ctx, coll, key, data, opts);
  }

  async function create(
    ctx: DocStoreContext,
    coll: DocCollection,
    data: Record<string, unknown>
  ): Promise<DocRecord> {
    return writeDoc(ctx, coll, newUlid(), data, { ifVersion: 0 });
  }

  async function remove(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    opts: { ifVersion?: number } = {}
  ): Promise<{ deleted: boolean }> {
    const policy = assertCollection(coll);
    assertKey(key);
    const viewer = requireViewer(ctx);
    assertShareWritable(coll, policy);
    const scope = scopeUid(ctx, coll);
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, scope, key])).rows[0];
      // Missing and hidden are indistinguishable to the caller here.
      if (!row || row.hidden) {
        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: 0 });
        }
        return { deleted: false };
      }
      const current = Number(row.version);
      if (opts.ifVersion !== undefined && opts.ifVersion !== current) {
        throw new DocStoreError('version_conflict', 'version conflict', {
          currentVersion: current,
        });
      }
      assertMayModify(ctx, coll, row);
      await c.query(SQL_DELETE_DOC, [ctx.appId, ctx.ns, coll.name, scope, key]);
      if (coll.config.visibility === 'shared') {
        await c.query(SQL_DELETE_TALLIES, [ctx.appId, ctx.ns, coll.name, key]);
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
      return { deleted: true };
    });
  }

  /**
   * Add `by` (1–100) to a declared counter of a visible shared document. In a
   * `write: 'none'` collection the first increment of an absent key CREATES the
   * document (empty, unowned, charged to the incrementer); under any other
   * policy an absent key is `not_found`, so nobody can squat keys by counting.
   */
  async function increment(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    counter: string,
    by = 1
  ): Promise<{ value: number }> {
    const policy = assertCollection(coll);
    assertKey(key);
    requireShared(coll, 'counters');
    if (!TALLY_NAME_SHAPE.test(counter) || !(coll.config.counters ?? []).includes(counter)) {
      throw invalid(`counter ${counter} is not declared`, { counter });
    }
    if (!Number.isSafeInteger(by) || by < 1 || by > B.incrementMax) {
      throw invalid(`by must be an integer from 1 to ${B.incrementMax}`);
    }
    const viewer = requireViewer(ctx);
    return withTx(ctx, async (c) => {
      const bump = async () =>
        Number(
          (await c.query(SQL_INCREMENT, [ctx.appId, ctx.ns, coll.name, key, counter, by])).rows[0]
            .count
        );
      // Two passes at most, as in writeDoc: a concurrent first increment of the
      // same key can win the INSERT; the loser's insert waits for it to commit,
      // inserts nothing, and the second pass increments the winner's document.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Existing visible doc: KEY SHARE only, so increments never serialise on it.
        const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
        if (doc.rows.length > 0) return { value: await bump() };
        if (policy !== 'none') throw new DocStoreError('not_found', 'document not found');

        const existing = (await c.query(SQL_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, 0, key]))
          .rows[0];
        if (existing) {
          if (existing.hidden) throw new DocStoreError('not_found', 'document not found');
          continue; // became visible between the two reads: increment it
        }
        const ins = await c.query(SQL_INSERT_COUNTER_DOC, [
          ctx.appId,
          ctx.ns,
          coll.name,
          key,
          viewer,
        ]);
        if (ins.rows.length === 0) continue; // lost the race; increment the winner's doc
        // Same accounting as any document create: the app and the creating
        // viewer's own ceiling (labelled `viewer`: it is the caller's), then the seq.
        const value = await bump();
        const size = Number(ins.rows[0].size_bytes);
        const seq = await charge(
          c,
          ctx,
          { bytes: size, docs: 1 },
          { uid: viewer, bytes: size, docs: 1, ceiling: 'viewer' }
        );
        await c.query(SQL_STAMP_SEQ, [ctx.appId, ctx.ns, coll.name, 0, key, seq, ctx.viewerUid]);
        return { value };
      }
      throw new DocStoreError('version_conflict', 'concurrent write; retry', {
        currentVersion: null,
      });
    });
  }

  function assertMarkName(coll: DocCollection, name: string) {
    requireShared(coll, 'marks');
    if (name === REPORT_MARK) return;
    if (!TALLY_NAME_SHAPE.test(name) || !(coll.config.marks ?? []).includes(name)) {
      throw invalid(`mark ${name} is not declared`, { mark: name });
    }
  }

  /** `count` is null for `report`, whose count is never exposed. */
  async function mark(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    name: string
  ): Promise<{ marked: true; count: number | null }> {
    assertCollection(coll);
    assertKey(key);
    assertMarkName(coll, name);
    const viewer = requireViewer(ctx);
    return withTx(ctx, async (c) => {
      const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
      if (doc.rows.length === 0) throw new DocStoreError('not_found', 'document not found');
      const args = [ctx.appId, ctx.ns, coll.name, key, name];
      const ins = await c.query(SQL_INSERT_MARK, [...args, viewer]);
      const res =
        ins.rows.length > 0
          ? await c.query(SQL_MARK_UP, args)
          : await c.query(SQL_MARK_COUNT, args);
      const count = Number(res.rows[0]?.count ?? 0);
      return { marked: true as const, count: name === REPORT_MARK ? null : count };
    });
  }

  async function unmark(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    name: string
  ): Promise<{ marked: false; count: number | null }> {
    assertCollection(coll);
    assertKey(key);
    assertMarkName(coll, name);
    refuseReportWithdrawal(name);
    const viewer = requireViewer(ctx);
    return withTx(ctx, async (c) => {
      const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
      if (doc.rows.length === 0) throw new DocStoreError('not_found', 'document not found');
      const args = [ctx.appId, ctx.ns, coll.name, key, name];
      const del = await c.query(SQL_DELETE_MARK, [...args, viewer]);
      const res =
        del.rows.length > 0
          ? await c.query(SQL_MARK_DOWN, args)
          : await c.query(SQL_MARK_COUNT, args);
      const count = Number(res.rows[0]?.count ?? 0);
      return { marked: false as const, count: name === REPORT_MARK ? null : count };
    });
  }

  /**
   * List one collection. Filters combine with AND: one declared-index equality,
   * `author=me`, `markedBy=me&mark=…` and `keyPrefix`. Order is the sort field
   * with the key as tiebreaker (both in the requested direction), paged by keyset
   * cursor. A sort or filter on an index lists only documents that HAVE that
   * index value; a tally sort lists every document, absent tallies as 0.
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
    const viewerParam = `${p(ctx.viewerUid)}::int`;
    const joins: string[] = [];
    const conds: string[] = [];

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
    if (q.markedBy !== undefined || q.mark !== undefined) {
      if (q.markedBy !== 'me' || q.mark === undefined) {
        throw invalid('markedBy=me and mark are required together');
      }
      assertMarkName(coll, q.mark);
      conds.push(listMarkedByMe(`${p(q.mark)}::text`, `${p(requireViewer(ctx))}::int`));
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
      case 'tally':
        joins.push(listSortTallyJoin(`${p(sort.tally)}::text`, `${p(sort.name)}::text`));
        sortExpr = `COALESCE(st.count, 0)`;
        sortValueExpr = `COALESCE(st.count, 0)::text`;
        cursorCast = `PARAM::bigint`;
        break;
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
      `SELECT ${docColumns(viewerParam)}, ${sortValueExpr} AS sort_value`,
      listBase(joins.join('\n')),
      ...conds.map((cnd) => `AND ${cnd}`),
      `ORDER BY ${orderBy}`,
      `LIMIT ${p(limit + 1)}::int`,
    ].join('\n');

    const rows = await withTx(ctx, async (c) => (await c.query(sql, params)).rows);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDocRecord(r, ctx, coll)),
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
      for (const sql of SQL_REVIEW_PURGE) {
        rows += Number((await c.query(sql, [publishRequestId])).rows[0]?.n ?? 0);
      }
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
      if (page.length < ACCOUNT_WIPE_PAGE) return out;
      after = page[page.length - 1];
    }
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
      counterDocsReleased: 0,
      marks: 0,
      namespaceRows: 0,
    };
    const n = (res: DocStoreQueryResult, col = 'n') => Number(res.rows[0]?.[col] ?? 0);
    return withTx(ctx, async (c) => {
      if (result.mode === 'namespace') {
        for (const sql of SQL_WIPE_NAMESPACE)
          result.namespaceRows += n(await c.query(sql, [appId, ns]));
        return result;
      }
      const args = [appId, ns, userId];
      /**
       * The document rows (LOCK ORDER (1)): every shared document the wipe touches is locked in
       * one ordered statement (`SQL_WIPE_LOCK_DOCS`), then the private documents are deleted and
       * the counter documents released. Nothing is charged here; `settle` does that once every
       * row lock is held.
       */
      const wipeDocs = async () => {
        const locked = (await c.query(SQL_WIPE_LOCK_DOCS, args)).rows;
        const authored = locked.filter((r) => r.authored === true).map(toLockedSharedDoc);
        const priv = await c.query(SQL_WIPE_PRIVATE_DOCS, args);
        const deleted = { docs: n(priv, 'docs'), bytes: n(priv, 'bytes') };
        result.privateDocs += deleted.docs;
        result.privateBytes += deleted.bytes;
        result.counterDocsReleased += n(await c.query(SQL_WIPE_RELEASE_COUNTER_DOCS, args));
        return { authored, deleted };
      };
      /**
       * Delete the locked authored documents exactly as a moderator delete does (tallies, marks,
       * app and author refunds, tombstones). The private documents refund nothing: the app's
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
      // Every tally this changes belongs to a document `wipeDocs` locked, so no other wipe can
      // hold one of them (LOCK ORDER (1b) after (1)).
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
      // in-flight writer created or a document this user marked meanwhile. That document can
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
      return result;
    });
  }

  /**
   * ACCOUNT WIPE (`removeAllContent`, a moderator content-removal action): remove one user from
   * the document store, in every app and namespace they have rows in. Per namespace, in one
   * transaction:
   *   - their own dev namespace (`dev:<uid>`) is deleted outright;
   *   - elsewhere, their private documents are deleted (index rows with them; the app's usage
   *     never carried them, so it is not refunded); their marks — reports included — are deleted and each tally decremented; the shared
   *     documents they authored are DELETED, hidden or not, exactly as a moderator delete does
   *     (index rows, tallies, every user's marks on them, app and author refunds, tombstones);
   *     counter-created documents charged to them keep their counters but lose the uid; their
   *     usage rows and private tombstones are deleted.
   * Idempotent: a re-run finds nothing left that names the user. A namespace whose transaction
   * fails is reported in `failures` (it rolled back in full) and the rest continue; a disabled
   * store throws `storage_disabled`.
   */
  async function wipeAccount(userId: number): Promise<AccountWipeResult> {
    assertWipeUserId(userId);
    const result: AccountWipeResult = { userId, namespaces: [], failures: [] };
    for (const { appId, ns } of await listAccountNamespaces(userId)) {
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

  const store = {
    get,
    getMany,
    put,
    create,
    delete: remove,
    list,
    increment,
    mark,
    unmark,
    usage,
    limits,
  };
  /**
   * Shared documents of `appId` under `key` in any of `collections`, production namespace only,
   * hidden included: at most two, enough to tell one match from several. Nothing is queried when
   * there is no valid collection or key.
   */
  async function findSharedByKey(
    appId: string,
    collections: readonly string[],
    key: string
  ): Promise<SharedKeyMatch[]> {
    const names = collections.filter((n) => B.collectionName.test(n));
    if (names.length === 0 || !B.key.test(key) || DOT_ONLY_KEY.test(key)) return [];
    const ctx: DocStoreContext = { appId, ns: PUBLISHED_NS, viewerUid: null };
    const rows = await withTx(
      ctx,
      async (c) => (await c.query(SQL_LOOKUP_SHARED_KEY, [ctx.appId, ctx.ns, names, key])).rows
    );
    return rows.map((r) => ({
      collection: r.coll as string,
      authorUid: r.author_uid === null || r.author_uid === undefined ? null : Number(r.author_uid),
      hidden: r.hidden === true,
    }));
  }

  return {
    store,
    lookup: { findSharedByKey },
    moderation: createModeration({ withTx, charge }),
    maintenance: { purgeReview, listReviewAppIds, wipeAccount },
  };
}

/**
 * SQLSTATEs that say the server cannot serve this connection: too_many_connections,
 * admin_shutdown, crash_shutdown, cannot_connect_now. Class 08 (connection exception) is
 * matched by prefix in `isPgConnectionFault`, except 08P01 (below).
 */
const PG_CONNECTION_SQLSTATES = new Set(['53300', '57P01', '57P02', '57P03']);
/**
 * 08P01 protocol_violation is retryable ONLY with one of these PgBouncer messages. Postgres also
 * raises 08P01 for a malformed message from US (e.g. "bind message supplies 1 parameters, but
 * prepared statement requires 2") — a bug, which must stay a 500 — and PgBouncer uses it for
 * permanent refusals too ("unsupported startup parameter"). Trade-off: a PgBouncer outage
 * message not listed here is a 500 rather than a retryable 503; widen the list when one is seen,
 * rather than matching 08P01 by code alone.
 */
const PGBOUNCER_TRANSIENT_08P01 =
  /server conn crashed\?|no more connections allowed|pgbouncer cannot connect to server|query_wait_timeout/i;
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
        if (typeof message === 'string' && PGBOUNCER_TRANSIENT_08P01.test(message)) return true;
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
  ).catch(() => undefined);
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
  ).catch(() => undefined);
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
// reports: `doc.reports_dismissed_at` records when, and only report marks made after that point
// count as OPEN (the queue and `reports` below). The marks themselves are kept, so each
// reporter's own "I reported this" state (`viewer.marks`) stays true. A report is one per user
// AND cannot be withdrawn (`unmark` refuses `report`), so a reporter cannot re-open a dismissed
// document by withdrawing and re-filing: only a report from someone who had not reported it
// re-opens it. Deleting the marks instead would tell reporters they never reported, and let
// each of them re-open it after every dismissal. Unhide does not touch the point, so it
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
  authorKind: 'user' | 'app' | 'counter';
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
  data: Record<string, unknown>;
  /** md5 of the stored jsonb text — what an audit row records instead of the content. */
  dataMd5: string;
  counters: Record<string, number>;
  marks: Record<string, number>;
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

// The queue for one (app, ns). Driven by the report marks through `doc_mark_name_idx`
// (app_id, ns, name, …), so its cost follows the app's REPORT marks — not its document count,
// and not its other marks (votes, likes…), which that index skips: documents with at least one
// OPEN report (made after any dismissal), counted per document. The other mark reads are served
// by the existing indexes (`markedBy=me` by `doc_mark_user_idx`, a document's own marks by the
// primary key). $1 app, $2 ns, $3 the report mark name; `statusCond` is a
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
// $5 the report mark name.
const SQL_MOD_GET = `SELECT d.coll, d.key, d.data, md5(d.data::text) AS data_md5, d.version, d.seq, d.size_bytes,
    d.author_uid, d.author_kind, d.created_at, d.updated_at, d.hidden_at, d.hidden_by,
    d.reports_dismissed_at,
    (SELECT jsonb_object_agg(t.kind || ':' || t.name, t.count) FROM appdata.doc_tally t
      WHERE t.app_id = $1 AND t.ns = $2 AND t.coll = d.coll AND t.key = d.key) AS tallies,
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
 * cascade), its tallies and marks are deleted, the app and the user its creation was charged to
 * are refunded, and a tombstone takes the next seq: the same accounting as an author delete.
 * Every document, tally and mark row is deleted before any usage row is charged (LOCK ORDER (1),
 * (1b), then (2), (3)). Returns each document's tombstone seq, in input order.
 */
async function deleteLockedSharedDocs(
  c: DocStoreClient,
  ctx: DocStoreContext,
  charge: ModerationDeps['charge'],
  docs: LockedSharedDoc[]
): Promise<number[]> {
  for (const d of docs) {
    await c.query(SQL_DELETE_DOC, [ctx.appId, ctx.ns, d.coll, 0, d.key]);
    await c.query(SQL_DELETE_TALLIES, [ctx.appId, ctx.ns, d.coll, d.key]);
    await c.query(SQL_DELETE_MARKS, [ctx.appId, ctx.ns, d.coll, d.key]);
  }
  const seqs: number[] = [];
  for (const d of docs) {
    const seq = await charge(
      c,
      ctx,
      { bytes: -d.sizeBytes, docs: -1 },
      // No user carries a doc without an author uid: a counter document whose creator's account
      // was wiped had its charge released with that account's usage row, and an app-authored
      // doc never charged one.
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

  /** One shared document, hidden or not, with every tally (the report count included). */
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
    const counters: Record<string, number> = {};
    const marks: Record<string, number> = {};
    for (const [k, v] of Object.entries((row.tallies ?? {}) as Record<string, number | string>)) {
      const sep = k.indexOf(':');
      (k.slice(0, sep) === 'counter' ? counters : marks)[k.slice(sep + 1)] = Number(v);
    }
    return {
      collection: row.coll as string,
      key: row.key as string,
      data: row.data as Record<string, unknown>,
      dataMd5: row.data_md5 as string,
      // Open reports only; `marks.report` keeps the all-time count.
      reports: Number(row.open_reports),
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
      counters,
      marks,
    };
  }

  /**
   * Hide (or unhide) one shared document. A hidden document reads as not found to the
   * app (`VISIBLE`) and keeps its data, tallies, marks and quota charge, so the action
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
   * cascade), its tallies and marks are deleted, the app and the charged author are
   * refunded (a counter-created doc's `author_uid` is the user its creation was charged
   * to), and a tombstone takes the next seq — the same accounting as an author delete.
   * A document with no `author_uid` (a counter document whose creator's account was wiped,
   * or app-authored) refunds the app only: no user carries it.
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
