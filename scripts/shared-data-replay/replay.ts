/**
 * The scan half of `scripts/replay-shared-data-moderation.ts`: walk every app's shared storage and
 * run each stored `data` blob and each counter key through the SAME classification the live
 * shadow/enforce scans use. Read the entry script's header for why this exists and how to run it.
 *
 * Nothing here records anything. `scanSharedData` / `scanCounterKey` / `blockingHit` /
 * `sharedDataHitRows` are the pure halves of `shared-data-moderation.ts`; the recording half
 * (`recordSharedDataScan`, `scheduleSharedDataShadow`) is deliberately not imported. Every SQL
 * statement issued here is a SELECT, and the entry script runs them inside a READ ONLY transaction,
 * so the database itself refuses a write.
 *
 * Every database read goes through an injected `Query`, so a test can assert exactly what is sent.
 */
import {
  blockingHit,
  scanCounterKey,
  scanSharedData,
  sharedDataHitRows,
  type SharedDataHitCategory,
  type SharedTextScan,
} from '~/server/services/apps/shared-data-moderation';
import { appSchemaIdent, isValidAppSlug } from '~/server/utils/apps-slug';
import { toCsvRows } from '~/utils/csv';

export type Query = <R>(sql: string, params?: unknown[]) => Promise<R[]>;

export interface Scanners {
  scanData: (data: unknown) => Promise<SharedTextScan>;
  scanCounter: (key: string) => Promise<SharedTextScan>;
}

/**
 * The live scans, called the way the router calls them. `isModerator` is left at its default
 * (false): a moderator author is exempt from the PATTERN list on the live path, and the replay does
 * not look authors up, so a moderator-authored pattern hit is counted here where live would not
 * count it. That errs toward reporting more, never less.
 */
export const liveScanners: Scanners = {
  scanData: (data) => scanSharedData(data),
  scanCounter: (key) => scanCounterKey(key),
};

// ── Schema enumeration ────────────────────────────────────────────────────────

/**
 * Every `app_` schema, with whether it holds each shared table. Read from `pg_catalog`, not
 * `information_schema`: the latter lists only tables the connecting role holds a privilege on, so a
 * missing grant would drop an app from the replay silently. A schema listed here that the role
 * cannot read fails its SELECT loudly instead.
 *
 * `\_` makes the underscore literal. Unescaped, `_` is LIKE's single-character wildcard and
 * `app_%` also matches `apprev_…`, the review sandboxes (`storage-provision.service.ts`).
 */
export const LIST_APP_SCHEMAS_SQL = `SELECT n.nspname AS schema,
  EXISTS (SELECT 1 FROM pg_catalog.pg_class c
          WHERE c.relnamespace = n.oid AND c.relname = 'shared_kv' AND c.relkind IN ('r', 'p')) AS has_shared_kv,
  EXISTS (SELECT 1 FROM pg_catalog.pg_class c
          WHERE c.relnamespace = n.oid AND c.relname = 'counters' AND c.relkind IN ('r', 'p')) AS has_counters
FROM pg_catalog.pg_namespace n
WHERE n.nspname LIKE 'app\\_%'
ORDER BY n.nspname`;

export interface AppSchemaRow {
  schema: string;
  has_shared_kv: boolean;
  has_counters: boolean;
}

export interface AppSchema {
  schema: string;
  slug: string;
  hasSharedKv: boolean;
  hasCounters: boolean;
}

/**
 * The provisioned schema shape: `app_` + a slug the provisioner's own rule accepts
 * (`isValidAppSlug`). Re-checked because the name becomes an SQL identifier (via `appSchemaIdent`,
 * the provisioner's quoting); a name that fails it is reported, never scanned, never dropped.
 */
const APP_SCHEMA_PREFIX = 'app_';

export interface AppSchemaSelection {
  /** Schemas holding `shared_kv` and/or `counters` — the ones to scan. */
  apps: AppSchema[];
  /** Well-formed `app_` schemas with neither table (per-user storage only). */
  withoutSharedTables: string[];
  /** Names that do not match the provisioned shape. Printed as a warning. */
  rejected: string[];
}

export function selectAppSchemas(rows: AppSchemaRow[]): AppSchemaSelection {
  const selection: AppSchemaSelection = { apps: [], withoutSharedTables: [], rejected: [] };
  for (const row of rows) {
    const slug = row.schema.slice(APP_SCHEMA_PREFIX.length);
    if (!row.schema.startsWith(APP_SCHEMA_PREFIX) || !isValidAppSlug(slug)) {
      selection.rejected.push(row.schema);
      continue;
    }
    if (!row.has_shared_kv && !row.has_counters) {
      selection.withoutSharedTables.push(row.schema);
      continue;
    }
    selection.apps.push({
      schema: row.schema,
      slug,
      hasSharedKv: row.has_shared_kv,
      hasCounters: row.has_counters,
    });
  }
  return selection;
}

// ── Per-app scan ──────────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 500;

/**
 * Keyset pages. `$1` is NULL on the first page rather than `''`, so a row whose key is the empty
 * string is not skipped by `key > ''`.
 *
 * `value ? 'data'` separates "no data" from a stored JSON `null`; both scan to zero leaves, but only
 * the first is a row without a blob, which is what `rowsWithData` counts.
 */
export const sharedKvPageSql = (slug: string) => `SELECT key,
  value ? 'data' AS has_data,
  value -> 'data' AS data,
  hidden_at IS NOT NULL AS hidden
FROM ${appSchemaIdent(slug)}.shared_kv
WHERE $1::text IS NULL OR key > $1
ORDER BY key
LIMIT $2`;

/**
 * Every counter key is scanned. `anchor` (the counter's `shared_kv` row is still the bare `{}` the
 * increment path inserts) is one input to `isUserChosenCounterKey`; see there for the rule.
 */
export const countersPageSql = (slug: string, joinSharedKv: boolean) =>
  joinSharedKv
    ? `SELECT c.key,
  s.value = '{}'::jsonb AS anchor,
  s.hidden_at IS NOT NULL AS hidden
FROM ${appSchemaIdent(slug)}.counters c
LEFT JOIN ${appSchemaIdent(slug)}.shared_kv s ON s.key = c.key
WHERE $1::text IS NULL OR c.key > $1
ORDER BY c.key
LIMIT $2`
    : `SELECT key, NULL::boolean AS anchor, false AS hidden
FROM ${appSchemaIdent(slug)}.counters
WHERE $1::text IS NULL OR key > $1
ORDER BY key
LIMIT $2`;

interface SharedKvRow {
  key: string;
  has_data: boolean;
  data: unknown;
  hidden: boolean;
}

interface CounterRow {
  key: string;
  anchor: boolean | null;
  hidden: boolean;
}

/** `newUlid()`'s output: 26 uppercase Crockford base32 characters (no I, L, O, U). */
const SERVER_GENERATED_KEY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Whether a counter's key is app-chosen text, i.e. a key a live increment scans when it creates it.
 *
 * Only two paths create `shared_kv` rows: append, whose key is always `newUlid()`, and the increment
 * that creates a counter, whose key is the app's and whose anchor row starts as `{}`. The anchor
 * alone is not enough: the author can later rewrite it through `updateSharedRow`, which checks only
 * key, author and not-hidden. So a key counts as user-chosen when its anchor is still `{}` OR it is
 * not ULID-shaped (no append could have made it). The key's shape survives an edit; the anchor does not.
 *
 * 🔴 RESIDUAL: an app-chosen key that happens to be ULID-shaped AND whose anchor was edited counts as
 * NOT user-chosen, so the user-chosen tally can undercount by exactly those keys. They are still
 * scanned, counted in the overall counter tally and written to the CSV. `formatSummary` says so.
 */
export const isUserChosenCounterKey = (key: string, anchor: boolean | null) =>
  anchor === true || !SERVER_GENERATED_KEY.test(key);

/** Printed under every summary, where the user-chosen numbers are read. */
export const USER_CHOSEN_NOTE =
  "note: userChosen = anchor row still '{}' OR key not ULID-shaped. An app-chosen ULID-shaped " +
  'counter key whose anchor row was edited counts as NOT user-chosen (it is still in counter hits, ' +
  'the overall would-block count and the CSV), so the user-chosen figures can undercount by those keys.';

export type ReplaySurface = 'data' | 'counter';

export interface ReplayCsvRow {
  app: string;
  surface: ReplaySurface;
  rowKey: string;
  hidden: boolean;
  leafPath: string;
  leafKind: string;
  category: SharedDataHitCategory;
  matched: string;
  leafLength: number;
  leaf: string;
  /**
   * Counter rows: whether the key is user-chosen (`isUserChosenCounterKey`: anchor still `{}` OR key
   * not ULID-shaped; an app-chosen ULID-shaped key with an edited anchor reads `false`). Data rows: null.
   */
  userChosenCounter: boolean | null;
  /**
   * `blockingHit` would reject this row/counter under enforce. A `pattern` hit does NOT block: live
   * enforce counts one only while `user-content-pattern-enforce` is on, and that flag is absent.
   */
  blocksUnderEnforce: boolean;
}

export const CSV_COLUMNS: ReadonlyArray<keyof ReplayCsvRow> = [
  'app',
  'surface',
  'rowKey',
  'hidden',
  'leafPath',
  'leafKind',
  'category',
  'matched',
  'leafLength',
  'leaf',
  'userChosenCounter',
  'blocksUnderEnforce',
];

/**
 * One CSV row per hit, built from `sharedDataHitRows` in SHADOW mode — so the leaf, the path and the
 * matched term are cut exactly as a live shadow record cuts them. The live `surface` is only a
 * placeholder there (the CSV carries its own `data` | `counter`), and `blocked` is not read.
 */
export function replayCsvRows(
  scan: SharedTextScan,
  ctx: {
    app: string;
    surface: ReplaySurface;
    rowKey: string;
    hidden: boolean;
    userChosenCounter?: boolean | null;
  }
): ReplayCsvRow[] {
  if (!scan.hits.length) return [];
  const blocksUnderEnforce = blockingHit(scan, { enforcePatterns: false }) !== null;
  return sharedDataHitRows(scan, {
    appBlockId: ctx.app,
    rowKey: ctx.rowKey,
    surface: ctx.surface === 'counter' ? 'counter' : 'update',
    mode: 'shadow',
    blocked: false,
  }).map((row) => ({
    app: ctx.app,
    surface: ctx.surface,
    rowKey: row.rowKey,
    hidden: ctx.hidden,
    leafPath: row.leafPath,
    leafKind: row.leafKind,
    category: row.category,
    matched: row.matched,
    leafLength: row.leafLength,
    leaf: row.leafText,
    userChosenCounter: ctx.userChosenCounter ?? null,
    blocksUnderEnforce,
  }));
}

export type CategoryCounts = Record<SharedDataHitCategory, number>;

const zeroCounts = (): CategoryCounts => ({
  minor: 0,
  poi: 0,
  link: 0,
  pattern: 0,
  audit_regex: 0,
  overflow: 0,
});

export interface AppTally {
  app: string;
  /** `shared_kv` rows read. */
  rows: number;
  /** …of which carry a `data` field. */
  rowsWithData: number;
  /** Distinct leaves classified across all `data` blobs (an overflowed blob contributes 0). */
  dataLeaves: number;
  counterKeys: number;
  /** …of which are user-chosen (`isUserChosenCounterKey`), i.e. the ones a live increment scans. */
  counterKeysUserChosen: number;
  hits: { data: CategoryCounts; counter: CategoryCounts };
  /** Rows / counter keys `blockingHit` would reject under enforce (a `pattern` hit does not block). */
  blocked: { data: number; counter: number };
  /** The counter figures again, for user-chosen keys only — the ones a live increment scans. */
  userChosenCounters: { hits: CategoryCounts; blocked: number };
}

export function emptyTally(app: string): AppTally {
  return {
    app,
    rows: 0,
    rowsWithData: 0,
    dataLeaves: 0,
    counterKeys: 0,
    counterKeysUserChosen: 0,
    hits: { data: zeroCounts(), counter: zeroCounts() },
    blocked: { data: 0, counter: 0 },
    userChosenCounters: { hits: zeroCounts(), blocked: 0 },
  };
}

function countScan(
  tally: AppTally,
  surface: ReplaySurface,
  scan: SharedTextScan,
  userChosenCounter = false
) {
  const blocks = blockingHit(scan, { enforcePatterns: false }) !== null;
  for (const hit of scan.hits) tally.hits[surface][hit.category] += 1;
  if (blocks) tally.blocked[surface] += 1;
  if (!userChosenCounter) return;
  const own = tally.userChosenCounters;
  for (const hit of scan.hits) own.hits[hit.category] += 1;
  if (blocks) own.blocked += 1;
}

async function* pages<R extends { key: string }>(query: Query, sql: string, pageSize: number) {
  let after: string | null = null;
  for (;;) {
    const page: R[] = await query<R>(sql, [after, pageSize]);
    if (page.length) yield page;
    if (page.length < pageSize) return;
    after = page[page.length - 1].key;
  }
}

/**
 * Scan one app's `shared_kv` rows and counter keys. Each hit is handed to `emit` as it is found, so
 * the caller can stream it to disk; the returned tally is the denominator.
 */
export async function replayApp(
  query: Query,
  app: AppSchema,
  emit: (row: ReplayCsvRow) => void,
  { scanners = liveScanners, pageSize = DEFAULT_PAGE_SIZE } = {}
): Promise<AppTally> {
  const tally = emptyTally(app.slug);

  if (app.hasSharedKv) {
    for await (const page of pages<SharedKvRow>(query, sharedKvPageSql(app.slug), pageSize)) {
      for (const row of page) {
        // Absent `data` is `undefined`, as the live path hands it over.
        const scan = await scanners.scanData(row.has_data ? row.data : undefined);
        tally.rows += 1;
        if (row.has_data) tally.rowsWithData += 1;
        tally.dataLeaves += scan.leafCount;
        countScan(tally, 'data', scan);
        const ctx = {
          app: app.slug,
          surface: 'data' as const,
          rowKey: row.key,
          hidden: row.hidden,
        };
        for (const csvRow of replayCsvRows(scan, ctx)) emit(csvRow);
      }
    }
  }

  if (app.hasCounters) {
    const sql = countersPageSql(app.slug, app.hasSharedKv);
    for await (const page of pages<CounterRow>(query, sql, pageSize)) {
      for (const row of page) {
        const scan = await scanners.scanCounter(row.key);
        tally.counterKeys += 1;
        const userChosenCounter = isUserChosenCounterKey(row.key, row.anchor);
        if (userChosenCounter) tally.counterKeysUserChosen += 1;
        countScan(tally, 'counter', scan, userChosenCounter);
        const ctx = {
          app: app.slug,
          surface: 'counter' as const,
          rowKey: row.key,
          hidden: row.hidden,
          userChosenCounter,
        };
        for (const csvRow of replayCsvRows(scan, ctx)) emit(csvRow);
      }
    }
  }

  return tally;
}

// ── Output ────────────────────────────────────────────────────────────────────

/**
 * One CSV line through the app's shared escaper (`~/utils/csv`): RFC 4180 quoting plus the
 * spreadsheet-formula guard, which matters here because the cells hold user-written text and the
 * file is meant to be opened by a reviewer. CRLF, the terminator `toCsvRows` joins with.
 */
const csvLine = (cells: unknown[]) => `${toCsvRows([cells])}\r\n`;

export const csvHeader = () => csvLine([...CSV_COLUMNS]);

export const csvRowLine = (row: ReplayCsvRow) => csvLine(CSV_COLUMNS.map((column) => row[column]));

export function totalTally(tallies: AppTally[]): AppTally {
  const total = emptyTally('TOTAL');
  for (const t of tallies) {
    total.rows += t.rows;
    total.rowsWithData += t.rowsWithData;
    total.dataLeaves += t.dataLeaves;
    total.counterKeys += t.counterKeys;
    total.counterKeysUserChosen += t.counterKeysUserChosen;
    for (const surface of ['data', 'counter'] as const) {
      for (const category of Object.keys(t.hits[surface]) as SharedDataHitCategory[]) {
        total.hits[surface][category] += t.hits[surface][category];
      }
      total.blocked[surface] += t.blocked[surface];
    }
    for (const category of Object.keys(t.userChosenCounters.hits) as SharedDataHitCategory[]) {
      total.userChosenCounters.hits[category] += t.userChosenCounters.hits[category];
    }
    total.userChosenCounters.blocked += t.userChosenCounters.blocked;
  }
  return total;
}

const countsText = (counts: CategoryCounts) =>
  (Object.entries(counts) as Array<[SharedDataHitCategory, number]>)
    .map(([category, n]) => `${category}=${n}`)
    .join(' ');

/** One block per app with any rows or counters, then the total, then `USER_CHOSEN_NOTE`. */
export function formatSummary(tallies: AppTally[]): string {
  const lines: string[] = [];
  const block = (t: AppTally) => {
    lines.push(
      `${t.app}: rows=${t.rows} rowsWithData=${t.rowsWithData} dataLeaves=${t.dataLeaves} ` +
        `counterKeys=${t.counterKeys} (userChosen=${t.counterKeysUserChosen})`,
      `  data hits:    ${countsText(t.hits.data)}`,
      `  counter hits: ${countsText(t.hits.counter)}`,
      `  user-chosen counter hits: ${countsText(t.userChosenCounters.hits)}`,
      `  would block under enforce (pattern hits do not block): data=${t.blocked.data} counter=${t.blocked.counter}`,
      `  user-chosen counters that would block: ${t.userChosenCounters.blocked}`
    );
  };
  for (const t of tallies) if (t.rows || t.counterKeys) block(t);
  block(totalTally(tallies));
  lines.push(USER_CHOSEN_NOTE);
  return lines.join('\n');
}

// ── Detector self-check ───────────────────────────────────────────────────────

/**
 * Prove the two blocklist-backed detectors are live before the replay is believed. They are the only
 * detectors that read lists at runtime (Redis, falling back to the main DB); every other detector is
 * code bundled in the app. An empty or unreadable list makes them return nothing, which in a replay
 * reads as a clean zero — so an empty list is an error, and so is a probe they fail to catch.
 *
 * The probe is built from the LIVE lists (an entry of each), so no list entry is written here. The
 * entries themselves are never printed.
 */
export async function blocklistSelfCheck(
  lists: { linkDomains: string[]; messagePatterns: string[] },
  scanData: Scanners['scanData'] = liveScanners.scanData
): Promise<void> {
  if (!lists.linkDomains.length) {
    throw new Error('LinkDomain blocklist read as EMPTY; the link detector would report nothing');
  }
  if (!lists.messagePatterns.length) {
    throw new Error(
      'MessagePattern blocklist read as EMPTY; the pattern detector would report nothing'
    );
  }
  // An ASCII host the link regex can match, and a pattern the lowercase substring check can match.
  const domain = lists.linkDomains.find((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  const pattern = lists.messagePatterns.find((p) => p.trim() && p === p.toLowerCase());
  if (!domain || !pattern) {
    throw new Error('no usable LinkDomain/MessagePattern entry to build the self-check probe from');
  }
  const scan = await scanData({ a: `see https://${domain}/x`, b: `zz ${pattern} zz` });
  const found = new Set(scan.hits.map((h) => h.category));
  const missing = (['link', 'pattern'] as const).filter((c) => !found.has(c));
  if (missing.length) {
    throw new Error(`self-check probe was not caught by: ${missing.join(', ')}`);
  }
}
