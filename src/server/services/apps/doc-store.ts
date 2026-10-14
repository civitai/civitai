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
// What this module does NOT do, by design — the caller (the REST layer) does it
// before calling in, and each is a seam at the call into an operation here:
//   - resolve the context (app id, namespace, viewer) from a verified token;
//   - the min-trust gate on viewer writes into shared collections (put, create,
//     delete, increment, mark, unmark);
//   - rate limits;
//   - content moderation of shared writes;
//   - map `DocStoreError` codes to HTTP statuses and envelopes;
//   - resolve `author.uid` to a username (and never forward the uid).
//
// QUOTA IS RACE-FREE BY CONSTRUCTION. A write changes the `doc` row first, then
// charges the size delta with one conditional statement per ceiling —
// `UPDATE … SET bytes = bytes + Δ WHERE bytes + Δ <= limit RETURNING …` (as an
// upsert, so a first write creates the row). Postgres re-evaluates that WHERE on
// the latest committed row after waiting for its lock, so two racing writers can
// never both pass a check that only one fits under; zero rows returned rolls the
// whole transaction back as `quota_exceeded`. There is no pre-flight read.
//
// LOCK ORDER, which is what makes it deadlock-free: (1) the document row of the
// one key being written, (1b) that document's tally and mark rows, (2)
// `usage_app` for (app, ns), (3) `usage_user` rows in ascending user id.
// Nothing takes a document or tally lock after (2), and every path that takes
// (3) holds (2) first — so at most one transaction per (app, ns) is ever waiting
// on a `usage_user` row, and no cycle can form. Incrementing an EXISTING
// document and marking take only a KEY SHARE lock on the document and the tally
// row, and no usage lock, as the proposal specifies; the first increment of an
// absent key creates the document and is charged like any other create.
//
// `seq` comes from `usage_app.last_seq`, incremented in the same statement that
// charges the quota and therefore row-locked until commit: per-(app, ns) seq
// order equals commit order, which is what a future change-feed poller needs.

import { createHash } from 'crypto';
import { escapeLiteral } from 'pg';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { newUlid } from '~/server/utils/app-block-ids';
import type {
  DocCollection,
  DocIndexType,
  DocListQuery,
  DocListResult,
  DocRangeFilter,
  DocRecord,
  DocStoreContext,
  DocStoreLimits,
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

/** What the store needs from a pool. `requireAppsDb()` satisfies it (checked below). */
export type DocStoreDb = { connect(): Promise<DocStoreClient> };

/** Compile-time proof that the apps pool fits the seam: `createDocStore({ db: requireAppsDb() })`. */
type AppsPoolFitsDocStoreDb = AugmentedPool extends DocStoreDb ? true : never;
// Fails `pnpm run typecheck` (true is not assignable to never) if the pool stops fitting.
export const APPS_POOL_FITS_DOC_STORE_DB: AppsPoolFitsDocStoreDb = true;

export type DocStoreDeps = {
  db: DocStoreDb;
  limits?: DocStoreLimits;
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
const NS_SHAPE = /^(prod|dev:[1-9][0-9]{0,9}|rev:[A-Za-z0-9_-]{1,64})$/;
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
}

function assertCollection(coll: DocCollection): void {
  if (!B.collectionName.test(coll.name)) throw invalid('invalid collection name');
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || !B.key.test(key)) {
    throw invalid('key must be 1–128 characters of [A-Za-z0-9._:-]');
  }
}

function requireViewer(ctx: DocStoreContext): number {
  if (ctx.viewerUid === null) throw new DocStoreError('sign_in_required', 'sign in required');
  return ctx.viewerUid;
}

/** The key space a collection's documents live in for this viewer. */
function scopeUid(ctx: DocStoreContext, coll: DocCollection, forWrite: boolean): number {
  if (coll.config.visibility === 'shared') return 0;
  // Private: one key space per viewer; anonymous viewers have none.
  if (ctx.viewerUid === null || forWrite) return requireViewer(ctx);
  return ctx.viewerUid;
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

function resolveExpiresAt(coll: DocCollection, expiresAt: Date | undefined): Date | null {
  if (expiresAt !== undefined) {
    if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
      throw invalid('expiresAt must be a valid date');
    }
    if (expiresAt.getTime() <= Date.now()) throw invalid('expiresAt must be in the future');
    return expiresAt;
  }
  const ttl = coll.config.ttlSeconds;
  return ttl && ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;
}

// ---------------------------------------------------------------------------
// Declared indexes
// ---------------------------------------------------------------------------

type IndexRow = { name: string; vText: string | null; vNum: number | null };
type IndexValue = { column: 'v_text' | 'v_num'; value: string | number };

function declaredIndexes(coll: DocCollection): [string, DocIndexType][] {
  const entries = Object.entries(coll.config.indexes ?? {});
  if (entries.length > B.indexesPerCollection) {
    throw invalid(`at most ${B.indexesPerCollection} indexes per collection`);
  }
  for (const [name] of entries) {
    if (!INDEX_NAME_SHAPE.test(name)) throw invalid('invalid index name', { index: name });
  }
  return entries;
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
        ? { name, vText: v.value as string, vNum: null }
        : { name, vText: null, vNum: v.value as number }
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

/** Document columns plus its tallies and the viewer's own marks. `viewerParam` is a placeholder. */
function docColumns(viewerParam: string): string {
  return `d.key, d.data, d.version, d.created_at, d.updated_at, d.expires_at, d.author_uid, d.author_kind,
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

const VISIBLE = `d.hidden_at IS NULL AND (d.expires_at IS NULL OR d.expires_at > now())`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 viewer, $6 keys
const SQL_GET_MANY = `SELECT ${docColumns('$5::int')}
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int
    AND d.key = ANY($6::text[]) AND ${VISIBLE}`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key
const SQL_LOCK_DOC = `SELECT d.version, d.author_uid, d.author_kind, d.size_bytes,
    d.hidden_at IS NOT NULL AS hidden,
    (d.expires_at IS NOT NULL AND d.expires_at <= now()) AS expired
  FROM appdata.doc d
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND d.key = $5
  FOR UPDATE`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid, $8 expires_at
const SQL_INSERT_DOC = `INSERT INTO appdata.doc AS d
    (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid, expires_at)
  VALUES ($1, $2, $3, $4::int, $5, $6::jsonb, 1, 0, $7::int, 'user', $7::int, $8::timestamptz)
  ON CONFLICT DO NOTHING
  RETURNING d.size_bytes`;

// A shared document created by the first increment of one of its counters:
// empty data and author_kind 'counter'. `author_uid` records the incrementer
// ONLY so the creation is charged to their per-user ceiling like any other
// create; it confers nothing — `author=me` and the `own` policy both require
// author_kind 'user', and readers see `{ kind: 'counter' }` with no uid.
// $1 app, $2 ns, $3 coll, $4 key, $5 incrementer, $6 expires_at
const SQL_INSERT_COUNTER_DOC = `INSERT INTO appdata.doc AS d
    (app_id, ns, coll, scope_uid, key, data, version, seq, author_uid, author_kind, last_writer_uid, expires_at)
  VALUES ($1, $2, $3, 0, $4, '{}'::jsonb, 1, 0, $5::int, 'counter', $5::int, $6::timestamptz)
  ON CONFLICT DO NOTHING
  RETURNING d.size_bytes`;

// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 data, $7 writer uid, $8 expires_at
const SQL_UPDATE_DOC = `UPDATE appdata.doc d
  SET data = $6::jsonb, version = d.version + 1, last_writer_uid = $7::int,
      updated_at = now(), expires_at = $8::timestamptz
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
// $1 app, $2 ns, $3 coll, $4 scope_uid, $5 key, $6 names, $7 v_text, $8 v_num
const SQL_SYNC_INDEX = `WITH gone AS (
    DELETE FROM appdata.doc_index ix
    WHERE ix.app_id = $1 AND ix.ns = $2 AND ix.coll = $3 AND ix.scope_uid = $4::int AND ix.key = $5
      AND NOT (ix.name = ANY($6::text[]))
  )
  INSERT INTO appdata.doc_index AS ix (app_id, ns, coll, scope_uid, key, name, v_text, v_num)
  SELECT $1, $2, $3, $4::int, $5, u.name, u.v_text, u.v_num
  FROM unnest($6::text[], $7::text[], $8::float8[]) AS u(name, v_text, v_num)
  ON CONFLICT (app_id, ns, coll, scope_uid, name, key)
  DO UPDATE SET v_text = EXCLUDED.v_text, v_num = EXCLUDED.v_num`;

// Charge the per-(app, ns) ceiling and take the next seq. Zero rows = over quota.
// A negative delta always passes, so a delete or a shrink is never refused, even
// over a ceiling that was lowered.
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

// The kind is a literal: this statement can only ever write a counter row.
// $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 by
const SQL_INCREMENT = `INSERT INTO appdata.doc_tally AS t (app_id, ns, coll, key, kind, name, count)
  VALUES ($1, $2, $3, $4, 'counter', $5, $6::bigint)
  ON CONFLICT (app_id, ns, coll, key, kind, name) DO UPDATE SET count = t.count + EXCLUDED.count
  RETURNING t.count`;

// A new shared document's zero tally rows, one per declared counter and mark, so
// tally sorts can inner-join. $1 app, $2 ns, $3 coll, $4 key, $5 kinds, $6 names
const SQL_SEED_TALLIES = `INSERT INTO appdata.doc_tally AS t (app_id, ns, coll, key, kind, name, count)
  SELECT $1, $2, $3, $4, u.kind, u.name, 0 FROM unnest($5::text[], $6::text[]) AS u(kind, name)
  ON CONFLICT (app_id, ns, coll, key, kind, name) DO NOTHING`;

// $1 app, $2 ns, $3 coll, $4 key, $5 name, $6 user, $7 reason
const SQL_INSERT_MARK = `INSERT INTO appdata.doc_mark AS mk (app_id, ns, coll, key, name, user_id, reason)
  VALUES ($1, $2, $3, $4, $5, $6::int, $7::text)
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

// List fragments. Aliases are fixed so every fragment's predicates are visible
// to the static isolation scan; only parameter placeholders are interpolated.
// $1 app, $2 ns, $3 coll, $4 scope_uid; `joins` are the fragments below.
const listBase = (joins: string) => `FROM appdata.doc d
  ${joins}
  WHERE d.app_id = $1 AND d.ns = $2 AND d.coll = $3 AND d.scope_uid = $4::int AND ${VISIBLE}`;
const LIST_EQ_JOIN: ((name: string, col: string, value: string) => string)[] = [
  (name, col, value) => `JOIN appdata.doc_index ix0 ON ix0.app_id = $1 AND ix0.ns = $2
    AND ix0.coll = d.coll AND ix0.scope_uid = d.scope_uid AND ix0.key = d.key
    AND ix0.name = ${name} AND ix0.${col} = ${value}`,
  (name, col, value) => `JOIN appdata.doc_index ix1 ON ix1.app_id = $1 AND ix1.ns = $2
    AND ix1.coll = d.coll AND ix1.scope_uid = d.scope_uid AND ix1.key = d.key
    AND ix1.name = ${name} AND ix1.${col} = ${value}`,
];
const listSortIndexJoin = (
  name: string
) => `JOIN appdata.doc_index sx ON sx.app_id = $1 AND sx.ns = $2
    AND sx.coll = d.coll AND sx.scope_uid = d.scope_uid AND sx.key = d.key AND sx.name = ${name}`;
const listSortTallyJoin = (kind: string, name: string) => `JOIN appdata.doc_tally st
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
    expiresAt: row.expires_at ? new Date(row.expires_at as string | Date) : null,
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
// List: sort, filters, cursor
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
const CURSOR_KIND: Record<string, string> = {
  key: 'k',
  createdAt: 'c',
  updatedAt: 'u',
  'index:v_text': 's',
  'index:v_num': 'n',
  tally: 't',
};

function sortTag(sort: SortSpec): string {
  if (sort.kind === 'index') return CURSOR_KIND[`index:${indexColumn(sort.type)}`];
  return CURSOR_KIND[sort.kind];
}

/** A declared index's type, by OWN property only — a request field named `constructor` is undeclared. */
function declaredIndexType(coll: DocCollection, field: string): DocIndexType | undefined {
  const indexes = coll.config.indexes;
  return indexes && Object.prototype.hasOwnProperty.call(indexes, field)
    ? indexes[field]
    : undefined;
}

function indexColumn(type: DocIndexType): 'v_text' | 'v_num' {
  return type === 'string' ? 'v_text' : 'v_num';
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

/**
 * Cursor = `<sortTag><dir><queryHash8>~<payload>~<lastKey>`. The payload is
 * base64url of the UTF-8 sort value for a string index (≤128 bytes → ≤171
 * chars), a decimal number otherwise, empty for `key`; the key is raw (ASCII,
 * ≤128, and `~` is not in its alphabet). Worst case 1+1+8+1+171+1+128 = 311
 * chars, under the 512 the server accepts — so the server can never issue a
 * cursor it would itself refuse. The hash binds the cursor to the collection,
 * filters and sort it was issued for.
 */
function encodeCursor(sort: SortSpec, queryHash: string, value: string, key: string): string {
  const payload = sort.kind === 'index' && sort.type === 'string' ? b64url(value) : value;
  const cursor = `${sortTag(sort)}${
    sort.desc ? 'd' : 'a'
  }${queryHash}${CURSOR_SEP}${payload}${CURSOR_SEP}${key}`;
  if (cursor.length > B.cursorChars) {
    // Unreachable by the arithmetic above; refuse to issue rather than hand out
    // a cursor the next request would reject.
    throw new Error('doc-store: cursor exceeds its own bound');
  }
  return cursor;
}

function decodeCursor(
  sort: SortSpec,
  queryHash: string,
  cursor: string
): { value: string; key: string } {
  const bad = () => invalid('invalid cursor');
  if (typeof cursor !== 'string' || cursor.length > B.cursorChars) throw bad();
  const first = cursor.indexOf(CURSOR_SEP);
  const last = cursor.lastIndexOf(CURSOR_SEP);
  if (first < 0 || last === first) throw bad();
  const head = cursor.slice(0, first);
  const payload = cursor.slice(first + 1, last);
  const key = cursor.slice(last + 1);
  if (head !== `${sortTag(sort)}${sort.desc ? 'd' : 'a'}${queryHash}`) throw bad();
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

function queryHash(coll: DocCollection, q: DocListQuery): string {
  const shape = JSON.stringify([
    coll.name,
    q.sort ?? 'key',
    Object.entries(q.where ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    q.author ?? null,
    q.markedBy ?? null,
    q.mark ?? null,
    q.keyPrefix ?? null,
  ]);
  return createHash('sha256').update(shape).digest('base64url').slice(0, 8);
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type UsageDelta = { bytes: number; docs: number };

export type DocStore = ReturnType<typeof createDocStore>;

export function createDocStore(deps: DocStoreDeps) {
  const limits = deps.limits ?? DEFAULT_DOC_STORE_LIMITS;

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
    const client = await deps.db.connect();
    let broken = false;
    try {
      await client.query(
        `BEGIN; SELECT set_config('appdata.app_id', ${escapeLiteral(
          ctx.appId
        )}, true), set_config('appdata.ns', ${escapeLiteral(
          ctx.ns
        )}, true), set_config('lock_timeout', '${LOCK_TIMEOUT}', true)`
      );
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
      throw translatePgError(err);
    } finally {
      client.release(broken);
    }
  }

  /**
   * Charge usage for one write and return its seq. Order: `usage_app` (which
   * also yields seq), then each `usage_user` in ascending user id.
   */
  async function charge(
    c: DocStoreClient,
    ctx: DocStoreContext,
    app: UsageDelta,
    users: Map<number, UsageDelta & { ceiling: QuotaCeiling }>
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
    const seq = Number(appRes.rows[0].last_seq);
    for (const uid of [...users.keys()].sort((a, b) => a - b)) {
      const d = users.get(uid)!;
      if (d.bytes === 0 && d.docs === 0) continue;
      const res = await c.query(SQL_CHARGE_USER, [
        ctx.appId,
        ctx.ns,
        uid,
        d.bytes,
        d.docs,
        limits.userBytes,
        limits.userDocs,
      ]);
      if (res.rows.length === 0) {
        throw new DocStoreError('quota_exceeded', 'storage quota exceeded', {
          ceiling: d.ceiling,
        });
      }
    }
    return seq;
  }

  /**
   * Who a document's bytes are charged to, besides the app: the viewer for a
   * private doc, the recorded user for a user- or counter-created shared doc,
   * nobody for an app-authored one. The ceiling label is `author` whenever the
   * doc's bytes belong to someone other than (possibly) the caller.
   */
  function chargee(
    coll: DocCollection,
    scope: number,
    authorKind: unknown,
    authorUid: unknown
  ): { uid: number; ceiling: QuotaCeiling } | null {
    if (coll.config.visibility === 'private') return { uid: scope, ceiling: 'viewer' };
    if (authorUid === null || authorUid === undefined) return null;
    if (authorKind === 'user') return { uid: Number(authorUid), ceiling: 'author' };
    // The viewer whose first increment created it (see SQL_INSERT_COUNTER_DOC).
    if (authorKind === 'counter') return { uid: Number(authorUid), ceiling: 'author' };
    return null;
  }

  function addUserDelta(
    users: Map<number, UsageDelta & { ceiling: QuotaCeiling }>,
    who: { uid: number; ceiling: QuotaCeiling } | null,
    bytes: number,
    docs: number
  ) {
    if (!who) return;
    const cur = users.get(who.uid) ?? { bytes: 0, docs: 0, ceiling: who.ceiling };
    cur.bytes += bytes;
    cur.docs += docs;
    users.set(who.uid, cur);
  }

  function assertShareWritable(ctx: DocStoreContext, coll: DocCollection) {
    if (coll.config.visibility !== 'shared') return;
    const write = coll.config.write ?? 'own';
    if (write === 'owner') {
      throw new DocStoreError('write_policy', 'only the app owner writes this collection');
    }
    if (write === 'none') {
      throw new DocStoreError(
        'write_policy',
        'documents in this collection are written by counters only'
      );
    }
  }

  function assertMayModify(
    ctx: DocStoreContext,
    coll: DocCollection,
    row: Record<string, unknown>
  ) {
    if (coll.config.visibility !== 'shared') return;
    if ((coll.config.write ?? 'own') !== 'own') return;
    const isAuthor = row.author_kind === 'user' && Number(row.author_uid) === ctx.viewerUid;
    if (!isAuthor)
      throw new DocStoreError('not_author', 'only the author may change this document');
  }

  async function writeDoc(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    data: unknown,
    opts: { ifVersion?: number; expiresAt?: Date }
  ): Promise<DocRecord> {
    assertCollection(coll);
    assertKey(key);
    const viewer = requireViewer(ctx);
    assertShareWritable(ctx, coll);
    if (
      opts.ifVersion !== undefined &&
      !(Number.isSafeInteger(opts.ifVersion) && opts.ifVersion >= 0)
    ) {
      throw invalid('ifVersion must be a non-negative integer');
    }
    const json = serializeData(data);
    const indexRows = indexRowsFor(coll, data as Record<string, unknown>);
    const hasIndexes = declaredIndexes(coll).length > 0;
    const expiresAt = resolveExpiresAt(coll, opts.expiresAt);
    const scope = scopeUid(ctx, coll, true);
    const base = [ctx.appId, ctx.ns, coll.name, scope, key];

    return withTx(ctx, async (c) => {
      const app: UsageDelta = { bytes: 0, docs: 0 };
      const users = new Map<number, UsageDelta & { ceiling: QuotaCeiling }>();

      // Two passes at most: a concurrent creator of the same key can win the
      // INSERT between our lock read and our insert; the second pass then sees
      // (and locks) its row.
      for (let attempt = 0; attempt < 2; attempt++) {
        const existing = (await c.query(SQL_LOCK_DOC, base)).rows[0];
        if (existing && existing.expired) {
          // An expired document is absent: drop it (and its tallies) and write
          // fresh, crediting its bytes back to whoever they were charged to.
          await purgeLocked(c, ctx, coll, scope, key);
          const oldSize = Number(existing.size_bytes);
          app.bytes -= oldSize;
          app.docs -= 1;
          addUserDelta(
            users,
            chargee(coll, scope, existing.author_kind, existing.author_uid),
            -oldSize,
            -1
          );
        } else if (existing) {
          if (existing.hidden) throw new DocStoreError('not_found', 'document not found');
          const current = Number(existing.version);
          if (opts.ifVersion !== undefined && opts.ifVersion !== current) {
            throw new DocStoreError('version_conflict', 'version conflict', {
              currentVersion: current,
            });
          }
          assertMayModify(ctx, coll, existing);
          const res = await c.query(SQL_UPDATE_DOC, [...base, json, viewer, expiresAt]);
          const delta = Number(res.rows[0].size_bytes) - Number(existing.size_bytes);
          app.bytes += delta;
          addUserDelta(
            users,
            chargee(coll, scope, existing.author_kind, existing.author_uid),
            delta,
            0
          );
          return finishWrite(c, ctx, coll, scope, key, indexRows, hasIndexes, app, users);
        }

        if (opts.ifVersion !== undefined && opts.ifVersion !== 0) {
          throw new DocStoreError('version_conflict', 'version conflict', { currentVersion: 0 });
        }
        const ins = await c.query(SQL_INSERT_DOC, [...base, json, viewer, expiresAt]);
        if (ins.rows.length === 0) continue; // lost the race; re-read
        const size = Number(ins.rows[0].size_bytes);
        app.bytes += size;
        app.docs += 1;
        addUserDelta(users, chargee(coll, scope, 'user', viewer), size, 1);
        return finishWrite(c, ctx, coll, scope, key, indexRows, hasIndexes, app, users);
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
    hasIndexes: boolean,
    app: UsageDelta,
    users: Map<number, UsageDelta & { ceiling: QuotaCeiling }>
  ): Promise<DocRecord> {
    // Every write, not only a create, so a counter or mark declared after the
    // document was created gets its row on the document's next write.
    await seedTallies(c, ctx, coll, key);
    if (hasIndexes) {
      await c.query(SQL_SYNC_INDEX, [
        ctx.appId,
        ctx.ns,
        coll.name,
        scope,
        key,
        indexRows.map((r) => r.name),
        indexRows.map((r) => r.vText),
        indexRows.map((r) => r.vNum),
      ]);
    }
    const seq = await charge(c, ctx, app, users);
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

  async function seedTallies(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string
  ) {
    if (coll.config.visibility !== 'shared') return;
    const counters = coll.config.counters ?? [];
    const marks = (coll.config.marks ?? []).filter((m) => m !== REPORT_MARK);
    if (counters.length + marks.length === 0) return;
    await c.query(SQL_SEED_TALLIES, [
      ctx.appId,
      ctx.ns,
      coll.name,
      key,
      [...counters.map(() => 'counter'), ...marks.map(() => 'mark')],
      [...counters, ...marks],
    ]);
  }

  /** Delete a locked document row and, for a shared doc, its tallies and marks. */
  async function purgeLocked(
    c: DocStoreClient,
    ctx: DocStoreContext,
    coll: DocCollection,
    scope: number,
    key: string
  ) {
    await c.query(SQL_DELETE_DOC, [ctx.appId, ctx.ns, coll.name, scope, key]);
    if (coll.config.visibility === 'shared') {
      await c.query(SQL_DELETE_TALLIES, [ctx.appId, ctx.ns, coll.name, key]);
      await c.query(SQL_DELETE_MARKS, [ctx.appId, ctx.ns, coll.name, key]);
    }
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
    const scope = scopeUid(ctx, coll, false);
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
    opts: { ifVersion?: number; expiresAt?: Date } = {}
  ): Promise<DocRecord> {
    if (coll.config.kind === 'log') {
      throw invalid('log collections take server-assigned keys only; use create');
    }
    return writeDoc(ctx, coll, key, data, opts);
  }

  async function create(
    ctx: DocStoreContext,
    coll: DocCollection,
    data: Record<string, unknown>,
    opts: { expiresAt?: Date } = {}
  ): Promise<DocRecord> {
    return writeDoc(ctx, coll, newUlid(), data, { ...opts, ifVersion: 0 });
  }

  async function remove(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    opts: { ifVersion?: number } = {}
  ): Promise<{ deleted: boolean }> {
    assertCollection(coll);
    assertKey(key);
    requireViewer(ctx);
    assertShareWritable(ctx, coll);
    const scope = scopeUid(ctx, coll, true);
    return withTx(ctx, async (c) => {
      const row = (await c.query(SQL_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, scope, key])).rows[0];
      // Missing, hidden and expired are indistinguishable to the caller.
      if (!row || row.hidden || row.expired) {
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
      await purgeLocked(c, ctx, coll, scope, key);
      const size = Number(row.size_bytes);
      const users = new Map<number, UsageDelta & { ceiling: QuotaCeiling }>();
      addUserDelta(users, chargee(coll, scope, row.author_kind, row.author_uid), -size, -1);
      const seq = await charge(c, ctx, { bytes: -size, docs: -1 }, users);
      await c.query(SQL_TOMBSTONE, [ctx.appId, ctx.ns, coll.name, scope, key, seq]);
      return { deleted: true };
    });
  }

  async function increment(
    ctx: DocStoreContext,
    coll: DocCollection,
    key: string,
    counter: string,
    by = 1
  ): Promise<{ value: number }> {
    assertCollection(coll);
    assertKey(key);
    requireShared(coll, 'counters');
    if (!TALLY_NAME_SHAPE.test(counter) || !(coll.config.counters ?? []).includes(counter)) {
      throw invalid(`counter ${counter} is not declared`, { counter });
    }
    if (!Number.isSafeInteger(by) || by < 1 || by > B.incrementMax) {
      throw invalid(`by must be an integer from 1 to ${B.incrementMax}`);
    }
    const viewer = requireViewer(ctx);
    const expiresAt = resolveExpiresAt(coll, undefined);
    return withTx(ctx, async (c) => {
      const bump = async () =>
        (await c.query(SQL_INCREMENT, [ctx.appId, ctx.ns, coll.name, key, counter, by])).rows[0];
      // Two passes at most, as in writeDoc: a concurrent first increment of the
      // same key can win the INSERT; the loser's insert waits for it to commit,
      // inserts nothing, and the second pass increments the winner's document.
      for (let attempt = 0; attempt < 2; attempt++) {
        // Existing visible doc: KEY SHARE only, so increments never serialise on it.
        const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
        if (doc.rows.length > 0) return { value: Number((await bump()).count) };

        // Absent, hidden or expired. Hidden stays not-found; expired is replaced.
        const app: UsageDelta = { bytes: 0, docs: 0 };
        const users = new Map<number, UsageDelta & { ceiling: QuotaCeiling }>();
        const existing = (await c.query(SQL_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, 0, key]))
          .rows[0];
        if (existing && !existing.expired) {
          if (existing.hidden) throw new DocStoreError('not_found', 'document not found');
          continue; // became visible between the two reads: increment it
        }
        if (existing) {
          await purgeLocked(c, ctx, coll, 0, key);
          const oldSize = Number(existing.size_bytes);
          app.bytes -= oldSize;
          app.docs -= 1;
          addUserDelta(
            users,
            chargee(coll, 0, existing.author_kind, existing.author_uid),
            -oldSize,
            -1
          );
        }
        // An owner-curated collection gains documents only from its owner.
        if ((coll.config.write ?? 'own') === 'owner') {
          throw new DocStoreError('not_found', 'document not found');
        }
        const ins = await c.query(SQL_INSERT_COUNTER_DOC, [
          ctx.appId,
          ctx.ns,
          coll.name,
          key,
          viewer,
          expiresAt,
        ]);
        if (ins.rows.length === 0) continue; // lost the race; increment the winner's doc
        // Same accounting as any document create: tallies, then the app and the
        // creating viewer's own ceiling (labelled `viewer`: it is the caller's),
        // then the seq.
        await seedTallies(c, ctx, coll, key);
        const value = Number((await bump()).count);
        const size = Number(ins.rows[0].size_bytes);
        app.bytes += size;
        app.docs += 1;
        addUserDelta(users, { uid: viewer, ceiling: 'viewer' }, size, 1);
        const seq = await charge(c, ctx, app, users);
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
    name: string,
    opts: { reason?: string } = {}
  ): Promise<{ marked: true; count: number | null }> {
    assertCollection(coll);
    assertKey(key);
    assertMarkName(coll, name);
    if (opts.reason !== undefined) {
      if (name !== REPORT_MARK) throw invalid('reason is accepted on report only');
      if (typeof opts.reason !== 'string' || opts.reason.length > B.reportReasonChars) {
        throw invalid(`reason must be at most ${B.reportReasonChars} characters`);
      }
      assertStoredString(opts.reason);
    }
    const viewer = requireViewer(ctx);
    return withTx(ctx, async (c) => {
      const doc = await c.query(SQL_SHARE_LOCK_DOC, [ctx.appId, ctx.ns, coll.name, key]);
      if (doc.rows.length === 0) throw new DocStoreError('not_found', 'document not found');
      const args = [ctx.appId, ctx.ns, coll.name, key, name];
      const ins = await c.query(SQL_INSERT_MARK, [...args, viewer, opts.reason ?? null]);
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
   * List one collection. Filters combine with AND: up to two declared-index
   * equalities, a range or prefix on the sort index, `author=me`,
   * `markedBy=me&mark=…` and `keyPrefix`. Order is the sort field with the key
   * as tiebreaker (both in the requested direction), paged by keyset cursor. A
   * sort or filter on an index lists only documents that HAVE that index value.
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
    const scope = scopeUid(ctx, coll, false);
    const sort = parseSort(coll, q.sort);
    const hash = queryHash(coll, q);

    const params: unknown[] = [ctx.appId, ctx.ns, coll.name, scope];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const viewerParam = `${p(ctx.viewerUid)}::int`;
    const joins: string[] = [];
    const conds: string[] = [];

    let eqCount = 0;
    let range: DocRangeFilter | null = null;
    for (const [field, raw] of Object.entries(q.where ?? {})) {
      const type = declaredIndexType(coll, field);
      if (!type) {
        throw new DocStoreError('index_not_declared', `${field} is not a declared index`, {
          field,
        });
      }
      if (raw !== null && typeof raw === 'object') {
        if (sort.kind !== 'index' || sort.name !== field) {
          throw invalid('a range or prefix filter is allowed on the sort field only', { field });
        }
        range = raw;
        continue;
      }
      if (eqCount >= B.equalityFilters) {
        throw invalid(`at most ${B.equalityFilters} equality filters`);
      }
      const v = indexValue(type, raw, field);
      const cast = v.column === 'v_text' ? '::text' : '::float8';
      joins.push(LIST_EQ_JOIN[eqCount](`${p(field)}::text`, v.column, `${p(v.value)}${cast}`));
      eqCount++;
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

    let sortExpr: string;
    // The key column of the table that drives the sort, so the keyset cursor and
    // ORDER BY sit on ONE table's index and stay an index seek, not a join filter.
    let keyExpr = 'd.key';
    let sortValueExpr: string;
    let cursorCast: string;
    switch (sort.kind) {
      case 'key':
        sortExpr = '';
        sortValueExpr = `''`;
        cursorCast = '';
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
        joins.push(listSortIndexJoin(`${p(sort.name)}::text`));
        sortExpr = `sx.${col}`;
        keyExpr = 'sx.key';
        sortValueExpr = col === 'v_text' ? `sx.v_text` : `sx.v_num::text`;
        cursorCast = col === 'v_text' ? `PARAM::text` : `PARAM::float8`;
        if (range) {
          const typed = (raw: unknown) => {
            const v = indexValue(sort.type, raw, sort.name);
            return `${p(v.value)}${col === 'v_text' ? '::text' : '::float8'}`;
          };
          if (range.gte !== undefined) conds.push(`sx.${col} >= ${typed(range.gte)}`);
          if (range.lte !== undefined) conds.push(`sx.${col} <= ${typed(range.lte)}`);
          if (range.prefix !== undefined) {
            if (sort.type !== 'string') throw invalid('prefix applies to string indexes only');
            const pv = typed(range.prefix);
            conds.push(`sx.v_text >= ${pv} AND starts_with(sx.v_text, ${pv})`);
          }
        }
        break;
      }
      case 'tally':
        joins.push(listSortTallyJoin(`${p(sort.tally)}::text`, `${p(sort.name)}::text`));
        // Every document write seeds a zero row per declared counter and mark
        // (SQL_SEED_TALLIES), so the inner join lets the tally index
        // (`doc_tally_top_idx`) drive the scan instead of sorting the collection.
        // A document NOT written since a counter or mark was added to the
        // declaration has no row and is absent from this sort until it is written,
        // incremented or marked — the same backfill gap a newly declared index has.
        sortExpr = `st.count`;
        keyExpr = 'st.key';
        sortValueExpr = `st.count::text`;
        cursorCast = `PARAM::bigint`;
        break;
    }

    if (q.cursor !== undefined) {
      const cur = decodeCursor(sort, hash, q.cursor);
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
          ? encodeCursor(sort, hash, String(last.sort_value), last.key as string)
          : null,
    };
  }

  return { get, getMany, put, create, delete: remove, list, increment, mark, unmark };
}

function translatePgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string };
  // lock_not_available: waited LOCK_TIMEOUT on a row lock (an app's usage row
  // under a write burst). Retryable; never park a pooled connection longer.
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
