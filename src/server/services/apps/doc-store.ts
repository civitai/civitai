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
//   - map `DocStoreError` codes to HTTP statuses and envelopes;
//   - resolve `author.uid` to a username (and never forward the uid).
//
// Deliberately not supported yet, refused with `invalid_request` so a
// declaration that uses them fails loudly: `write: 'anyone'`, `ttlSeconds`,
// `kind: 'log'` and `maxEntries`.
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
import { newUlid } from '~/server/utils/app-block-ids';
import type {
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

export type DocStore = ReturnType<typeof createDocStore>;

export function createDocStore(deps: DocStoreDeps) {
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
    if (!deps.db) {
      throw new DocStoreError('storage_disabled', 'document storage is not configured');
    }
    const client = await deps.db.connect();
    let broken = false;
    try {
      await assertLeastPrivilege(client);
    } catch (err) {
      client.release();
      throw err;
    }
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
            app: { bytes: delta, docs: 0 },
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
          app: { bytes: size, docs: 1 },
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
      const seq = await charge(
        c,
        ctx,
        { bytes: -size, docs: -1 },
        { uid: viewer, bytes: -size, docs: -1, ceiling: ceilingFor(coll) }
      );
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

  return {
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
}

function translatePgError(err: unknown): unknown {
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
