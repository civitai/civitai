import { buzzAccountTypes } from '@civitai/buzz';
import { fromClickhouseTransactionType } from '~/server/clickhouse/transaction-type';
import { redactTransactionCounterparty } from '~/server/services/buzz-transaction-redaction';
import { CH_COLUMN_ALLOWED, columnDecision } from '../column-policy';
import { jsonLinesFile, type ExportWriter, type ManifestCount, type ManifestFile } from '../output';

/** What the export needs of a ClickHouse client: a parameterised query whose rows stream. */
export type ClickhouseReader = {
  query: (args: {
    query: string;
    query_params?: Record<string, unknown>;
    format: 'JSONEachRow';
    clickhouse_settings?: Record<string, unknown>;
  }) => Promise<{
    stream: () => AsyncIterable<{ json: <T>() => T }[]>;
    json: <T>() => Promise<T>;
  }>;
};

export const CH_MAX_EXECUTION_SECONDS = 300;

/**
 * A per-user read of a table whose sort key does not start with `userId` scans the whole table.
 * Below this many rows that is cheap; above it the read is skipped (a file is marked not included, a
 * count is left out) unless the table is `required`. Sizes and keys are read from system.tables
 * when the export runs.
 */
export const CH_SCAN_ROW_LIMIT = 25_000_000;

/**
 * The Buzz account types keyed by a USER id. A club account is keyed by the club's id, so a club
 * whose id equals the user's would otherwise put its members' transactions in this user's archive.
 * Both spellings, since some types are stored kebab-cased.
 */
export const USER_BUZZ_ACCOUNT_TYPES = [
  ...new Set(
    buzzAccountTypes
      .filter((t) => t !== 'club')
      .flatMap((t) => [t, t.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)])
  ),
];

type ChTable = {
  file: string;
  table: string;
  /**
   * Over `{uid:Int64}` / `{uidText:String}`; picked by the user column's type when null. A list is
   * read as one query per predicate, each skipping the rows an earlier one matched, so each can use
   * its own projection where an OR of them would scan the whole table.
   */
  where: string | readonly string[] | null;
  description: string;
  /** Kept keys; every other key is dropped. Unset: every key except credentials and classifier. */
  keep?: RegExp;
  /** Columns of this table never written, whatever `keep` and the name policy say. */
  drop?: readonly string[];
  /** Fields added to every record. */
  add?: Record<string, unknown>;
  /** Read even when it means a full scan: the record is one the export must carry. */
  required?: boolean;
  /** Applied to each kept record last. */
  redact?: (row: Record<string, unknown>) => Record<string, unknown>;
  /**
   * A record that cannot be reliably attributed (corrupted in storage): left out, not rewritten, and
   * counted in the manifest.
   */
  unreliable?: (row: Record<string, unknown>) => boolean;
};

/** Control characters or the replacement character: binary garbage stored in a text column. */
function notText(value: string) {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0xfffd)
      return true;
  }
  return false;
}
/** Generation history cannot predate this, nor come from the future. */
const EARLIEST_RECORD = Date.UTC(2020, 0, 1);

/** Corrupted job rows: a text value that is not text, or a creation time outside any real range. */
export function unreliableJobRow(row: Record<string, unknown>, now = Date.now()) {
  if (Object.values(row).some((v) => typeof v === 'string' && notText(v))) return true;
  const created = Date.parse(`${String(row.createdAt ?? '').replace(' ', 'T')}Z`);
  return !Number.isFinite(created) || created < EARLIEST_RECORD || created > now + 86_400_000;
}

/** A Buzz row as the owner sees it in the app: no other user's id from `details` or the ledger id. */
export function redactBuzzRow(row: Record<string, unknown>) {
  let details: Record<string, unknown> | null = null;
  if (row.details && typeof row.details === 'object') {
    details = row.details as Record<string, unknown>;
  } else if (typeof row.details === 'string' && row.details) {
    try {
      const parsed: unknown = JSON.parse(row.details);
      if (parsed && typeof parsed === 'object') details = parsed as Record<string, unknown>;
    } catch {
      // Unreadable details are dropped rather than passed through unchecked.
    }
  }
  const redacted = redactTransactionCounterparty({
    type: fromClickhouseTransactionType(String(row.type ?? '')),
    details,
    externalTransactionId:
      typeof row.externalTransactionId === 'string' ? row.externalTransactionId : null,
  });
  const out = { ...row };
  if ('details' in row) out.details = redacted.details;
  if ('externalTransactionId' in row) out.externalTransactionId = redacted.externalTransactionId;
  return out;
}

/** Rows exported in full (after the column policy). */
export const CH_TABLES: ChTable[] = [
  {
    file: 'data/clickhouse/buzz-transactions.jsonl',
    table: 'default.buzzTransactions',
    where: [
      'fromAccountId = {uid:Int64} AND fromAccountType IN {buzzTypes:Array(String)}',
      'toAccountId = {uid:Int64} AND toAccountType IN {buzzTypes:Array(String)}',
    ],
    description: 'Your Buzz transactions, in and out, for every account type.',
    // A money record: the ledger is exported even though its key starts with the date.
    required: true,
    redact: redactBuzzRow,
  },
  {
    file: 'data/clickhouse/account-activity.jsonl',
    table: 'default.userActivities',
    where: null,
    description: 'Account activity, including sign-ins with IP address and device.',
    // Sign-ins are in scope for every request.
    required: true,
    // Withheld by decision: on a mute or unmute it carries the moderation reason, and the row is
    // exported to its actor. Scoped to this table; a `source` column elsewhere is decided there.
    drop: ['source'],
  },
  {
    file: 'data/clickhouse/generation-jobs.jsonl',
    table: 'orchestration.jobs',
    where: null,
    description: 'Your generation job history.',
    // Every request carries it: read whatever the table's size, by its approved column list.
    required: true,
    unreliable: (row) => unreliableJobRow(row),
    // Stored as is; an empty provider reads as unknown.
    redact: (row) => ({ ...row, provider: row.provider ? row.provider : 'unknown' }),
  },
  {
    file: 'data/clickhouse/blocked-prompts.jsonl',
    table: 'default.prohibitedRequests',
    where: null,
    description: 'Prompts of yours that were blocked: the prompt and when.',
    keep: /^(time|createdAt|date|prompt|negativePrompt)$/,
    add: { blocked: true },
  },
  {
    file: 'data/clickhouse/blocked-content.jsonl',
    table: 'orchestration.blockedContent',
    where: null,
    description: 'Generation requests of yours that were blocked: the prompt and when.',
    keep: /^(time|createdAt|date|prompt|negativePrompt)$/,
    add: { blocked: true },
  },
];

/** Activity counted by type: counts only, never the events. */
export const CH_COUNT_TABLES = [
  'views',
  'pageViews',
  'impressions',
  'search',
  'shares',
  'reactions',
  'comments',
  'images',
  'posts',
  'modelEngagements',
  'userEngagements',
  'tagEngagements',
  'userModelDownloads',
  'files',
  'adImpressions',
  'modelEvents',
  'modelVersionEvents',
  'commentEvents',
] as const;

/**
 * Columns of a fully exported ClickHouse row that are dropped by name: moderation, detection and
 * staff fields. Not an allowlist, because the columns are not known in code.
 */
export const CH_DENY_RE =
  /(moderat|blocked|nsfw|verdict|flag|scan|score|label|rule|reason|internal|review|minor|poi|By$|ById$)/i;

/** Each table's keep/drop decision per column name, made once instead of once per row. */
const keptColumns = new WeakMap<ChTable, Map<string, boolean>>();

function keepsColumn(table: ChTable, k: string) {
  let decided = keptColumns.get(table);
  if (!decided) keptColumns.set(table, (decided = new Map()));
  let keep = decided.get(k);
  if (keep === undefined) {
    keep = table.drop?.includes(k)
      ? false
      : table.keep
      ? table.keep.test(k)
      : columnDecision(`ch:${table.table}`, k) === 'read' && !CH_DENY_RE.test(k);
    decided.set(k, keep);
  }
  return keep;
}

export function reduceChRow(table: ChTable, row: Record<string, unknown>) {
  const allowed = CH_COLUMN_ALLOWED[table.table];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (allowed && !allowed.includes(k)) continue;
    if (!keepsColumn(table, k)) continue;
    out[k] = v;
  }
  const kept = { ...out, ...table.add };
  return table.redact ? table.redact(kept) : kept;
}

/** The WHERE of each query a table is read with: a row matched by an earlier one is not read again. */
export function chWheres(table: ChTable, userWhere: string): string[] {
  const list = table.where;
  if (list == null) return [userWhere];
  if (typeof list === 'string') return [list];
  return list.map((w, i) =>
    [`(${w})`, ...list.slice(0, i).map((prev) => `NOT (${prev})`)].join(' AND ')
  );
}

/** How the user column compares: `orchestration` stores user ids as strings in some tables. */
async function userColumnTypes(ch: ClickhouseReader) {
  const rs = await ch.query({
    query: `SELECT concat(database, '.', table) AS t, type FROM system.columns
            WHERE name = 'userId' AND database IN ('default', 'orchestration')`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ t: string; type: string }[]>();
  return new Map(rows.map((r) => [r.t, r.type]));
}

/** Each table's sort key and size, from the catalog: no table data is read. */
async function tableShapes(ch: ClickhouseReader) {
  const rs = await ch.query({
    query: `SELECT concat(database, '.', name) AS t, sorting_key AS sortingKey, total_rows AS rows
            FROM system.tables WHERE database IN ('default', 'orchestration')`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json<{ t: string; sortingKey: string; rows: string | number | null }[]>();
  return new Map(
    rows.map((r) => [r.t, { sortingKey: r.sortingKey ?? '', rows: Number(r.rows ?? 0) }])
  );
}

export async function exportClickhouse({
  userId,
  writer,
  ch,
  onError,
}: {
  userId: number;
  writer: ExportWriter;
  ch: ClickhouseReader;
  onError: (table: string, e: unknown) => void;
}): Promise<{ files: ManifestFile[]; counts: ManifestCount[] }> {
  const params = { uid: userId, uidText: String(userId), buzzTypes: USER_BUZZ_ACCOUNT_TYPES };
  const settings = { max_execution_time: CH_MAX_EXECUTION_SECONDS };
  const types = await userColumnTypes(ch);
  const shape = await tableShapes(ch);
  const scannable = (t: string, required = false) => {
    if (required) return true;
    const s = shape.get(t);
    return !!s && (s.sortingKey.startsWith('userId') || s.rows < CH_SCAN_ROW_LIMIT);
  };
  const userWhere = (t: string) =>
    /String/.test(types.get(t) ?? '') ? 'userId = {uidText:String}' : 'userId = {uid:Int64}';

  const files: ManifestFile[] = [];
  for (const table of CH_TABLES) {
    const entry: ManifestFile = {
      file: table.file,
      source: 'clickhouse',
      rows: 0,
      description: table.description,
      status: 'complete',
    };
    files.push(entry);
    if (!scannable(table.table, table.required)) {
      entry.status = 'not-included';
      continue;
    }
    const allowed = CH_COLUMN_ALLOWED[table.table];
    const select = allowed ? allowed.map((c) => '`' + c + '`').join(', ') : '*';
    const open = (where: string) =>
      ch.query({
        query: `SELECT ${select} FROM ${table.table} WHERE ${where}`,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: settings,
      });
    const wheres = chWheres(table, userWhere(table.table));
    let first: Awaited<ReturnType<ClickhouseReader['query']>>;
    try {
      first = await open(wheres[0]);
    } catch (e) {
      entry.status = 'unavailable';
      onError(table.table, e);
      continue;
    }
    // A read that fails part-way (the time limit on a large scan, a dropped connection) keeps the
    // records already written and marks the file partial; it never fails the whole export.
    const records = async function* () {
      try {
        for (let i = 0; i < wheres.length; i++) {
          const rs = i === 0 ? first : await open(wheres[i]);
          for await (const rows of rs.stream())
            for (const row of rows) {
              const raw = row.json<Record<string, unknown>>();
              if (table.unreliable?.(raw)) {
                entry.leftOut = (entry.leftOut ?? 0) + 1;
                continue;
              }
              yield reduceChRow(table, raw);
            }
        }
      } catch (e) {
        entry.status = 'partial';
        onError(table.table, e);
      }
    };
    await writer.addFile(
      table.file,
      jsonLinesFile(records(), () => entry.rows++)
    );
  }

  const counts: ManifestCount[] = [];
  for (const t of CH_COUNT_TABLES) {
    const name = `default.${t}`;
    if (!scannable(name)) {
      counts.push({ name: t, source: 'clickhouse', count: null });
      continue;
    }
    try {
      const rs = await ch.query({
        query: `SELECT count() AS n FROM ${name} WHERE ${userWhere(name)}`,
        query_params: params,
        format: 'JSONEachRow',
        clickhouse_settings: settings,
      });
      const [row] = await rs.json<{ n: string | number }[]>();
      counts.push({ name: t, source: 'clickhouse', count: Number(row?.n ?? 0) });
    } catch (e) {
      counts.push({ name: t, source: 'clickhouse', count: null });
      onError(name, e);
    }
  }
  if (!scannable('default.actions')) {
    counts.push({ name: 'actions', source: 'clickhouse', count: null });
    return { files, counts };
  }
  try {
    const rs = await ch.query({
      query: `SELECT type, count() AS n FROM default.actions WHERE userId = {uid:Int64} GROUP BY type ORDER BY type`,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: settings,
    });
    for (const row of await rs.json<{ type: string; n: string | number }[]>())
      counts.push({ name: `actions:${row.type}`, source: 'clickhouse', count: Number(row.n) });
  } catch (e) {
    counts.push({ name: 'actions', source: 'clickhouse', count: null });
    onError('default.actions', e);
  }
  return { files, counts };
}
