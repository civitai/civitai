import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import {
  PAGE_SIZE,
  levelsFor,
  type AgreementRow,
  type DailyCounts,
  type Filters,
  type WouldRaiseRow,
} from '$lib/shadow-sexual-prompt';

export const SHADOW_TABLE = 'shadow_sexual_prompt_results';

// A rescan appends a row rather than replacing one (a new workflow, or an edited prompt under a new
// hash), so every panel counts an image once, by its LATEST scan. One argMax over a tuple takes every
// column from that same row; workflowId breaks a tie between two scans in the same second.
// The inner aliases must not reuse a source column's name: ClickHouse resolves a name inside an
// aggregate to a same-named alias, which nests one aggregate in another.
const LATEST_COLUMNS = [
  'triggered',
  'field',
  'score',
  'onSite',
  'currentNsfwLevel',
  'wouldNsfwLevel',
  'wouldRaise',
] as const;

export const latestPerImage = (source = SHADOW_TABLE) => `
  latest AS (
    SELECT imageId, ${LATEST_COLUMNS.map((c, i) => `pick.${i + 1} AS ${c}`).join(
      ', '
    )}, lastScan AS scannedAt
    FROM (
      SELECT
        imageId,
        argMax(tuple(${LATEST_COLUMNS.join(', ')}), (scannedAt, workflowId)) AS pick,
        max(scannedAt) AS lastScan
      FROM ${source}
      WHERE toDate(scannedAt, 'UTC') > toDate(now(), 'UTC') - {days:UInt32}
      GROUP BY imageId
    )
  )`;

// The scan reads both prompts, and a verdict the model attributes to the negative prompt is not a
// sexual prompt. Counting it would report fires the rule never acts on.
export const FIRED = `(triggered = 1 AND field != 'Negative Prompt')`;

const ON_SITE: Record<Filters['source'], number | null> = { all: null, on: 1, off: 0 };

type Query = { query: string; query_params: Record<string, unknown> };

function scope(filters: Pick<Filters, 'days' | 'source'>) {
  const onSite = ON_SITE[filters.source];
  return {
    where: onSite === null ? [] : ['onSite = {onSite:UInt8}'],
    params: onSite === null ? { days: filters.days } : { days: filters.days, onSite },
  };
}

const whereClause = (conditions: string[]) =>
  conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

export function dailyCountsQuery(
  filters: Pick<Filters, 'days' | 'source'>,
  source?: string
): Query {
  const { where, params } = scope(filters);
  return {
    query: `
      WITH ${latestPerImage(source)}
      SELECT
        toString(toDate(scannedAt, 'UTC')) AS day,
        count() AS scanned,
        countIf(${FIRED}) AS fired,
        countIf(wouldRaise = 1) AS raised,
        countIf(wouldRaise = 1 AND currentNsfwLevel = 1) AS raisedFromPg,
        countIf(wouldRaise = 1 AND currentNsfwLevel = 2) AS raisedFromPg13,
        countIf(wouldRaise = 1 AND currentNsfwLevel >= 4) AS raisedFromRPlus,
        countIf(wouldRaise = 1 AND currentNsfwLevel = 0) AS raisedFromUnrated
      FROM latest
      ${whereClause(where)}
      GROUP BY day
      ORDER BY day DESC
    `,
    query_params: params,
  };
}

export function agreementQuery(filters: Pick<Filters, 'days' | 'source'>, source?: string): Query {
  const { where, params } = scope(filters);
  return {
    query: `
      WITH ${latestPerImage(source)}
      SELECT
        currentNsfwLevel AS level,
        countIf(${FIRED}) AS fired,
        countIf(NOT ${FIRED}) AS notFired
      FROM latest
      ${whereClause(where)}
      GROUP BY level
      ORDER BY level
    `,
    query_params: params,
  };
}

function raiseScope(filters: Filters) {
  const { where, params } = scope(filters);
  const levels = levelsFor(filters.current);
  return {
    where: [
      'wouldRaise = 1',
      ...where,
      ...(levels ? ['has({levels:Array(UInt8)}, currentNsfwLevel)'] : []),
    ],
    params: levels ? { ...params, levels: [...levels] } : params,
  };
}

export function wouldRaiseListQuery(filters: Filters, source?: string): Query {
  const { where, params } = raiseScope(filters);
  return {
    query: `
      WITH ${latestPerImage(source)}
      SELECT imageId, currentNsfwLevel, wouldNsfwLevel, score, field, onSite, scannedAt
      FROM latest
      ${whereClause(where)}
      ORDER BY scannedAt DESC, imageId DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `,
    query_params: { ...params, limit: PAGE_SIZE, offset: (filters.page - 1) * PAGE_SIZE },
  };
}

export function wouldRaiseCountQuery(filters: Filters, source?: string): Query {
  const { where, params } = raiseScope(filters);
  return {
    query: `
      WITH ${latestPerImage(source)}
      SELECT count() AS total
      FROM latest
      ${whereClause(where)}
    `,
    query_params: params,
  };
}

// ClickHouse's JSON format quotes 64-bit integers, so every count and the UInt64 id arrive as strings.
const toNumbers = <T extends Record<string, unknown>>(
  row: Record<string, unknown>,
  keys: string[]
) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, keys.includes(k) ? Number(v) : v])
  ) as T;

async function run({ query, query_params }: Query): Promise<Record<string, unknown>[]> {
  const resp = await getClickhouse().query({ query, query_params, format: 'JSONEachRow' });
  return resp.json<Record<string, unknown>>();
}

const COUNT_KEYS = [
  'scanned',
  'fired',
  'raised',
  'raisedFromPg',
  'raisedFromPg13',
  'raisedFromRPlus',
  'raisedFromUnrated',
] as const;

/** One row per day in the window, newest first. A day with no scans is a zero row, not a gap, so a
 *  quiet day reads as quiet rather than as missing data. */
export function fillDays(rows: DailyCounts[], days: number, today = new Date()): DailyCounts[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start - i * 86_400_000).toISOString().slice(0, 10);
    return (
      byDay.get(day) ?? {
        day,
        ...(Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Omit<DailyCounts, 'day'>),
      }
    );
  });
}

export async function getDailyCounts(
  filters: Pick<Filters, 'days' | 'source'>
): Promise<DailyCounts[]> {
  const rows = await run(dailyCountsQuery(filters));
  return fillDays(
    rows.map((r) => toNumbers<DailyCounts>(r, [...COUNT_KEYS])),
    filters.days
  );
}

export async function getAgreement(
  filters: Pick<Filters, 'days' | 'source'>
): Promise<AgreementRow[]> {
  const rows = await run(agreementQuery(filters));
  return rows.map((r) => toNumbers<AgreementRow>(r, ['level', 'fired', 'notFired']));
}

export async function getWouldRaise(
  filters: Filters
): Promise<{ rows: WouldRaiseRow[]; total: number }> {
  const [rows, count] = await Promise.all([
    run(wouldRaiseListQuery(filters)),
    run(wouldRaiseCountQuery(filters)),
  ]);
  return {
    total: Number(count[0]?.total ?? 0),
    rows: rows.map((r) => ({
      imageId: Number(r.imageId),
      currentNsfwLevel: Number(r.currentNsfwLevel),
      wouldNsfwLevel: Number(r.wouldNsfwLevel),
      score: Number(r.score),
      field: String(r.field),
      onSite: Number(r.onSite) === 1,
      scannedAt: clickhouseDate(String(r.scannedAt)),
    })),
  };
}
