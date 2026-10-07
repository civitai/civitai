import { createHash } from 'crypto';
import type { QueryResult } from 'pg';
import * as z from 'zod';
import type { AugmentedPool } from '~/server/db/db-helpers';
import { queryWithTimeout } from '~/server/db/db-helpers';
import type {
  MilestoneCandidateRow,
  RowDetectorGroup,
} from '~/server/services/creator-milestone-detectors';
import type { MilestoneRegistryEntry } from '~/server/services/creator-milestone-registry';
import { creatorMilestoneRegistry } from '~/server/services/creator-milestone-registry';

/**
 * A milestone whose detector is stored on its own "CreatorMilestone" row instead of in the code
 * registry. The stored query runs in a read-only transaction on the read pool, and the writer only
 * inserts the rows it returned.
 */
export const storedDetectorSchema = z.strictObject({
  type: z.literal('query'),
  /** Postgres. Selects exactly "userId" int and "achievedAt" timestamptz; reads `$1` int[] when `clickhouse` is set. */
  sql: z
    .string()
    .trim()
    .min(1)
    .refine((sql) => !sql.endsWith(';')),
  /** ClickHouse. Selects exactly `id`; the ids become the Postgres query's `$1`. */
  clickhouse: z.string().trim().min(1).optional(),
  /** Whether every row carries the moment it was achieved. Undated rows must leave it NULL. */
  dated: z.boolean(),
  launchedAt: z.iso.datetime().transform((at) => new Date(at)),
  silent: z.literal(true).optional(),
});

export type StoredDetector = z.infer<typeof storedDetectorSchema>;

export type StoredMilestoneSkipReason =
  | 'invalid-definition'
  | 'unknown-detector'
  | 'key-collision'
  | 'timeout'
  | 'read-only-violation'
  | 'query-error'
  | 'shape'
  | 'row-cap'
  | 'clickhouse-error'
  | 'clickhouse-shape';

/**
 * Names the key and a reason, never the stored query or its parameters: logs are as public as the
 * repo is to anyone who can read them.
 */
export class StoredMilestoneSkip extends Error {
  constructor(
    readonly milestoneKey: string,
    readonly reason: StoredMilestoneSkipReason,
    readonly code?: string
  ) {
    super(`${milestoneKey}: ${reason}${code ? ` ${code}` : ''}`);
    this.name = 'StoredMilestoneSkip';
  }
}

export type QueryClickhouse = (
  sql: string,
  settings: Record<string, string | number>
) => Promise<unknown[]>;

export type StoredQueryLimits = { timeoutMs: number; rowCap: number };

export const STORED_QUERY_LIMITS: StoredQueryLimits = { timeoutMs: 60_000, rowCap: 100_000 };

const PG_INT4 = 23;
const PG_TIMESTAMPTZ = 1184;

const sqlState = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
};

function toSkip(milestoneKey: string, e: unknown) {
  if (e instanceof StoredMilestoneSkip) return e;
  const code = sqlState(e);
  if (code === '57014') return new StoredMilestoneSkip(milestoneKey, 'timeout', code);
  if (code === '25006') return new StoredMilestoneSkip(milestoneKey, 'read-only-violation', code);
  return new StoredMilestoneSkip(milestoneKey, 'query-error', code);
}

async function clickhouseIds(
  milestoneKey: string,
  sql: string,
  queryClickhouse: QueryClickhouse,
  { timeoutMs, rowCap }: StoredQueryLimits
) {
  let rows: unknown[];
  try {
    rows = await queryClickhouse(sql, {
      readonly: '1',
      max_execution_time: Math.ceil(timeoutMs / 1000),
      max_result_rows: rowCap,
      result_overflow_mode: 'throw',
    });
  } catch {
    throw new StoredMilestoneSkip(milestoneKey, 'clickhouse-error');
  }
  if (rows.length > rowCap) throw new StoredMilestoneSkip(milestoneKey, 'row-cap');
  const ids = new Set<number>();
  for (const row of rows) {
    const keys = row && typeof row === 'object' ? Object.keys(row) : [];
    const id = (row as { id?: unknown } | null)?.id;
    if (keys.length !== 1 || keys[0] !== 'id' || !Number.isSafeInteger(id))
      throw new StoredMilestoneSkip(milestoneKey, 'clickhouse-shape');
    ids.add(id as number);
  }
  return [...ids];
}

function checkShape(milestoneKey: string, result: QueryResult) {
  const fields = result.fields.map((f) => `${f.name}:${f.dataTypeID}`).sort();
  if (fields.join(',') !== `achievedAt:${PG_TIMESTAMPTZ},userId:${PG_INT4}`)
    throw new StoredMilestoneSkip(milestoneKey, 'shape');
}

/** The users a stored detector finds who do not hold its milestone yet, each at their earliest achievedAt. */
export async function findStoredCandidates(
  readPg: AugmentedPool,
  milestoneKey: string,
  detector: StoredDetector,
  {
    queryClickhouse,
    limits = STORED_QUERY_LIMITS,
  }: { queryClickhouse?: QueryClickhouse; limits?: StoredQueryLimits }
): Promise<MilestoneCandidateRow[]> {
  let params: unknown[] = [];
  if (detector.clickhouse) {
    if (!queryClickhouse) throw new StoredMilestoneSkip(milestoneKey, 'clickhouse-error');
    params = [await clickhouseIds(milestoneKey, detector.clickhouse, queryClickhouse, limits)];
  }

  let found: QueryResult;
  try {
    // The newline keeps a trailing line comment in the stored text from swallowing the parenthesis.
    found = await queryWithTimeout(
      readPg,
      limits.timeoutMs,
      `SELECT * FROM (\n${detector.sql}\n) AS stored
      WHERE NOT EXISTS (
        SELECT 1 FROM "UserCreatorMilestone" held
        WHERE held."userId" = stored."userId" AND held."milestoneKey" = $${params.length + 1}
      )
      LIMIT ${limits.rowCap + 1}`,
      [...params, milestoneKey]
    );
  } catch (e) {
    throw toSkip(milestoneKey, e);
  }
  checkShape(milestoneKey, found);
  if (found.rows.length > limits.rowCap) throw new StoredMilestoneSkip(milestoneKey, 'row-cap');

  const earliest = new Map<number, Date | null>();
  for (const { userId, achievedAt } of found.rows as { userId: unknown; achievedAt: unknown }[]) {
    if (!Number.isSafeInteger(userId) || (userId as number) <= 0)
      throw new StoredMilestoneSkip(milestoneKey, 'shape');
    const at = achievedAt as Date | null;
    if (detector.dated ? !(at instanceof Date) || Number.isNaN(at.getTime()) : at !== null)
      throw new StoredMilestoneSkip(milestoneKey, 'shape');
    const id = userId as number;
    const seen = earliest.get(id);
    if (seen === undefined || (seen && at && at < seen)) earliest.set(id, at);
  }
  return [...earliest].map(([userId, achievedAt]) => ({ userId, milestoneKey, achievedAt }));
}

export type StoredDefinitionRow = { key: string; detector: unknown };

/** What a stored detector grants, so editing it makes the next run silent instead of announcing a backlog. */
export function storedDetectorFingerprint(detector: StoredDetector) {
  const { sql, clickhouse, dated } = detector;
  return createHash('sha256')
    .update(JSON.stringify({ sql, clickhouse, dated }))
    .digest('hex')
    .slice(0, 16);
}

/** One group per valid stored definition. Anything else is skipped and reported by key and reason. */
export function storedMilestoneGroups(
  rows: StoredDefinitionRow[],
  {
    registry = creatorMilestoneRegistry,
    onSkip,
    queryClickhouse,
    limits,
  }: {
    registry?: Record<string, MilestoneRegistryEntry>;
    onSkip: (skip: StoredMilestoneSkip) => void;
    queryClickhouse?: QueryClickhouse;
    limits?: StoredQueryLimits;
  }
): RowDetectorGroup[] {
  const groups: RowDetectorGroup[] = [];
  for (const { key, detector: raw } of rows) {
    if (registry[key]) {
      onSkip(new StoredMilestoneSkip(key, 'key-collision'));
      continue;
    }
    if ((raw as { type?: unknown } | null)?.type !== 'query') {
      onSkip(new StoredMilestoneSkip(key, 'unknown-detector'));
      continue;
    }
    const parsed = storedDetectorSchema.safeParse(raw);
    if (!parsed.success) {
      onSkip(new StoredMilestoneSkip(key, 'invalid-definition'));
      continue;
    }
    const detector = parsed.data;
    groups.push({
      id: `stored:${key}`,
      watermarkId: `stored:${key}`,
      keys: [key],
      launchedAt: detector.launchedAt,
      silent: !!detector.silent,
      timed: detector.dated,
      fingerprint: storedDetectorFingerprint(detector),
      candidates: (readPg) =>
        findStoredCandidates(readPg, key, detector, { queryClickhouse, limits }),
    });
  }
  return groups;
}

export async function loadStoredMilestoneGroups(
  pg: AugmentedPool,
  options: Parameters<typeof storedMilestoneGroups>[1]
) {
  const query = await pg.cancellableQuery<StoredDefinitionRow>(
    `SELECT key, detector FROM "CreatorMilestone" WHERE detector IS NOT NULL ORDER BY key`
  );
  return storedMilestoneGroups(await query.result(), options);
}
