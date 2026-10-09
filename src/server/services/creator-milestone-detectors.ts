import type { AugmentedPool } from '~/server/db/db-helpers';
import type { MilestoneRegistryEntry } from '~/server/services/creator-milestone-registry';
import {
  creatorMilestoneRegistry,
  USER_METRICS,
} from '~/server/services/creator-milestone-registry';
import type { QueryClickhouse } from '~/server/services/creator-milestone-stored';

type ActivityEntry = Exclude<
  MilestoneRegistryEntry,
  { detector: 'scoreSnapshot' | 'judgeVotes' | 'competeWins' }
>;

type DetectorGroupBase = {
  id: string;
  /** The group's identity without its silence, so toggling silence keeps one watermark row. */
  watermarkId: string;
  keys: string[];
  launchedAt: Date;
  silent: boolean;
  /** Whether "achievedAt" is the real moment. Without it, a crossing cannot be dated. */
  timed: boolean;
  /** Anything beyond the keys and thresholds that changes what the group grants. */
  fingerprint?: string;
};

/**
 * One set-based query per group of keys that share a detector, params, launch date and silence. It
 * selects "userId", "milestoneKey" and "achievedAt" (NULL when the moment is unknown) for every key
 * a user has reached but does not hold. `keys` and `users` are SQL placeholders; `users` narrows the
 * scan to those user ids, and NULL means everyone.
 */
export type SqlDetectorGroup = DetectorGroupBase & {
  sql: (placeholders: { keys: string; users: string }) => string;
};

export type MilestoneCandidateRow = {
  userId: number;
  milestoneKey: string;
  achievedAt: Date | null;
};

/** A group whose candidates are found once, on the read pool, and only inserted on the writer. */
export type RowDetectorGroup = DetectorGroupBase & {
  candidates: (readPg: AugmentedPool) => Promise<MilestoneCandidateRow[]>;
};

export type MilestoneDetectorGroup = SqlDetectorGroup | RowDetectorGroup;

const notHeld = (user: string) => `NOT EXISTS (
    SELECT 1 FROM "UserCreatorMilestone" held
    WHERE held."userId" = ${user} AND held."milestoneKey" = m.key
  )`;

// Only work anyone can see counts. publishedAt is required to date the Nth item.
const publishedSources = {
  model: `SELECT x."userId", x."publishedAt", x.id FROM "Model" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND (x.mode IS NULL OR x.mode != 'Archived')
      AND x."deletedAt" IS NULL AND x."publishedAt" IS NOT NULL`,
  article: `SELECT x."userId", x."publishedAt", x.id FROM "Article" x
    WHERE x.status = 'Published' AND x.availability != 'Private'
      AND x."publishedAt" IS NOT NULL AND x."publishedAt" <= now()`,
} as const;

export const modelDownloadsSource = `SELECT mm."userId", mm."downloadCount" FROM "ModelMetric" mm
    WHERE mm.status = 'Published' AND mm.availability <> 'Private'`;

// Gross: what buyers paid, before the platform cut and any reseller share. A cosmetic's sale goes to
// its creator wherever it was bought. A pack's price is split: each member another creator made is
// credited to that creator at its recorded price, official members to nobody, and the rest to the
// creator who built the pack.
const packOthersSql = `SELECT pc."buzzTransactionId", pc."cosmeticId", pc."unitAmount", c."createdById"
    FROM "UserCosmeticShopPurchaseCosmetic" pc
    JOIN "Cosmetic" c ON c.id = pc."cosmeticId"`;

export const shopSalesSource = `SELECT c."createdById" AS "userId", p."purchasedAt", p."buzzTransactionId" AS id,
      p."unitAmount" AS amount
    FROM "UserCosmeticShopPurchases" p
    JOIN "Cosmetic" c ON c.id = p."cosmeticId"
    WHERE NOT p.refunded AND c."createdById" IS NOT NULL
    UNION ALL
    SELECT i."addedById", p."purchasedAt", p."buzzTransactionId",
      greatest(p."unitAmount" - coalesce((
        SELECT sum(m."unitAmount") FROM (${packOthersSql}) m
        WHERE m."buzzTransactionId" = p."buzzTransactionId"
          AND m."createdById" IS DISTINCT FROM i."addedById"
      ), 0), 0)
    FROM "UserCosmeticShopPurchases" p
    JOIN "CosmeticShopItem" i ON i.id = p."shopItemId"
    WHERE NOT p.refunded AND p."cosmeticId" IS NULL AND i."addedById" IS NOT NULL
    UNION ALL
    SELECT m."createdById", p."purchasedAt", m."buzzTransactionId" || ':' || m."cosmeticId",
      m."unitAmount"
    FROM (${packOthersSql}) m
    JOIN "UserCosmeticShopPurchases" p ON p."buzzTransactionId" = m."buzzTransactionId"
    JOIN "CosmeticShopItem" i ON i.id = p."shopItemId"
    WHERE NOT p.refunded AND m."createdById" IS NOT NULL
      AND m."createdById" IS DISTINCT FROM i."addedById"`;

/**
 * A win is a prize place in a contest someone else ran, one per contest: a place in a daily
 * challenge, or in a community challenge or completed Crucible with at least 10 distinct entrants
 * besides the host. A Crucible place counts only if its share of the pool is above zero.
 * Challenge wins are dated when the winner was recorded, which for community challenges can be days
 * after they close; a Crucible's places are written within a minute of its end.
 */
export const COMPETE_MIN_ENTRANTS = 10;

export const competeWinsSource = `SELECT cw."userId", cw."createdAt" AS at, 'challenge:' || cw."challengeId" AS contest
    FROM "ChallengeWinner" cw
    JOIN "Challenge" ch ON ch.id = cw."challengeId"
    WHERE ch.source IN ('System', 'Mod')
      OR (ch.source = 'User' AND ch."createdById" IS DISTINCT FROM cw."userId"
        AND (SELECT count(DISTINCT ci."addedById") FROM "CollectionItem" ci
          WHERE ci."collectionId" = ch."collectionId"
            AND ci."addedById" IS DISTINCT FROM ch."createdById") >= ${COMPETE_MIN_ENTRANTS})
    UNION ALL
    SELECT ce."userId", coalesce(c."endAt", c."updatedAt"), 'crucible:' || c.id
    FROM "CrucibleEntry" ce
    JOIN "Crucible" c ON c.id = ce."crucibleId"
    WHERE c.status = 'Completed' AND (c."prizePositions" -> ce.position::text) > '0'::jsonb
      AND ce."userId" <> c."userId"
      AND (SELECT count(DISTINCT e."userId") FROM "CrucibleEntry" e
        WHERE e."crucibleId" = c.id AND e."userId" <> c."userId") >= ${COMPETE_MIN_ENTRANTS}
    GROUP BY ce."userId", c.id`;

const userMetricSource = `SELECT um."userId", ${USER_METRICS.map((m) => `um."${m}"`).join(', ')}
    FROM "UserMetric" um WHERE um.timeframe = 'AllTime'`;

/** One user's current count per activity measure (`$1` is the user id), on the detectors' own rules. */
export const activityValuesSql = `SELECT
    (SELECT count(*) FROM (${publishedSources.model}) s WHERE s."userId" = $1)::int AS models,
    (SELECT count(*) FROM (${publishedSources.article}) s WHERE s."userId" = $1)::int AS articles,
    -- GROUP BY keeps the planner off the max() rewrite, which walks the whole downloads index for a
    -- heavy uploader with no public model (1.5s on prod).
    coalesce((SELECT max(s."downloadCount") FROM (${modelDownloadsSource}) s
      WHERE s."userId" = $1 GROUP BY s."userId"), 0)::int AS downloads,
    coalesce((SELECT s."followerCount" FROM (${userMetricSource}) s
      WHERE s."userId" = $1), 0)::int AS followers,
    coalesce((SELECT s."reactionCount" FROM (${userMetricSource}) s
      WHERE s."userId" = $1), 0)::int AS reactions,
    -- Clamped: a bigint sum past int range would otherwise fail the whole page.
    least(coalesce((SELECT sum(s.amount) FROM (${shopSalesSource}) s WHERE s."userId" = $1), 0),
      2147483647)::int AS revenue,
    -- Wins in Postgres only; the page adds the ledger's.
    (SELECT count(*) FROM (${competeWinsSource}) s WHERE s."userId" = $1)::int AS wins`;

function detectorSql(entry: ActivityEntry): SqlDetectorGroup['sql'] {
  switch (entry.detector) {
    // The Nth item still published is dated by its own publishedAt.
    case 'publishedCount':
      return ({ keys, users }) => `
        SELECT r."userId", m.key AS "milestoneKey", r."publishedAt" AS "achievedAt"
        FROM (
          SELECT s."userId", s."publishedAt",
            row_number() OVER (PARTITION BY s."userId" ORDER BY s."publishedAt", s.id) AS n
          FROM (${publishedSources[entry.params.entity]}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
        ) r
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND m.threshold = r.n
        WHERE ${notHeld('r."userId"')}`;
    case 'modelDownloads':
      return ({ keys, users }) => `
        SELECT d."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM (
          SELECT s."userId", max(s."downloadCount") AS top
          FROM (${modelDownloadsSource}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
          GROUP BY s."userId"
        ) d
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[]) AND d.top >= m.threshold
        WHERE ${notHeld('d."userId"')}`;
    case 'userMetric':
      return ({ keys, users }) => `
        SELECT um."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
        FROM (${userMetricSource}) um
        JOIN "CreatorMilestone" m
          ON m.key = ANY(${keys}::text[]) AND um."${entry.params.metric}" >= m.threshold
        WHERE (${users}::int[] IS NULL OR um."userId" = ANY(${users}::int[]))
          AND ${notHeld('um."userId"')}`;
    // Dated by the sale that carried the running total across the threshold.
    case 'shopRevenue':
      return ({ keys, users }) => `
        SELECT r."userId", m.key AS "milestoneKey", r."purchasedAt" AS "achievedAt"
        FROM (
          SELECT s."userId", s."purchasedAt", s.amount,
            sum(s.amount) OVER (
              PARTITION BY s."userId" ORDER BY s."purchasedAt", s.id ROWS UNBOUNDED PRECEDING
            ) AS total
          FROM (${shopSalesSource}) s
          WHERE (${users}::int[] IS NULL OR s."userId" = ANY(${users}::int[]))
        ) r
        JOIN "CreatorMilestone" m ON m.key = ANY(${keys}::text[])
          AND r.total >= m.threshold AND r.total - r.amount < m.threshold
        WHERE ${notHeld('r."userId"')}`;
  }
}

/** The registry's activity keys, grouped so each group is one query. Score tiers run in their own job. */
export function activityDetectorGroups(
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
): SqlDetectorGroup[] {
  const groups = new Map<string, SqlDetectorGroup>();
  for (const [key, entry] of Object.entries(registry)) {
    if (
      entry.detector === 'scoreSnapshot' ||
      entry.detector === 'judgeVotes' ||
      entry.detector === 'competeWins'
    )
      continue;
    const watermarkId = [
      entry.detector,
      ...Object.values(entry.params),
      entry.launchedAt.toISOString(),
    ].join(':');
    const id = `${watermarkId}:${entry.silent ? 'silent' : 'announced'}`;
    const group = groups.get(id);
    if (group) group.keys.push(key);
    else
      groups.set(id, {
        id,
        watermarkId,
        keys: [key],
        launchedAt: entry.launchedAt,
        silent: !!entry.silent,
        timed: entry.detector === 'publishedCount' || entry.detector === 'shopRevenue',
        sql: detectorSql(entry),
      });
  }
  return [...groups.values()];
}

// Rows before 2026-10-04 carry userId 0, so they count for nobody.
export const judgeVoteCountSql = `SELECT count() AS votes FROM crucible_votes
  WHERE userId = {userId:UInt32}`;

export const judgeVoteTotalsSql = (min: number) => `SELECT userId, count() AS votes
  FROM crucible_votes WHERE userId > 0 GROUP BY userId HAVING votes >= ${Math.trunc(min)}`;

const CLICKHOUSE_QUERY_LIMITS = { max_execution_time: 60, max_result_rows: 1_000_000 };

/** Judge ranks count Crucible votes, which only ClickHouse holds, so they are found row by row. */
export function judgeVoteGroups(
  queryClickhouse: QueryClickhouse,
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
): RowDetectorGroup[] {
  const entries = Object.entries(registry).filter(([, entry]) => entry.detector === 'judgeVotes');
  if (!entries.length) return [];
  const [, first] = entries[0];
  const keys = entries.map(([key]) => key);
  const watermarkId = ['judgeVotes', first.launchedAt.toISOString()].join(':');
  return [
    {
      id: `${watermarkId}:${first.silent ? 'silent' : 'announced'}`,
      watermarkId,
      keys,
      launchedAt: first.launchedAt,
      silent: !!first.silent,
      timed: false,
      candidates: async (readPg) => {
        const thresholds = await readPg.cancellableQuery<{ min: number | null }>(
          `SELECT min(threshold)::int AS min FROM "CreatorMilestone" WHERE key = ANY($1::text[])`,
          [keys]
        );
        const [{ min } = { min: null }] = await thresholds.result();
        // An empty answer here would record a complete run, and the next one would announce every judge.
        if (min == null) throw new Error('No CreatorMilestone thresholds for the judge ranks');

        const totals = (await queryClickhouse(judgeVoteTotalsSql(min), {
          readonly: '1',
          ...CLICKHOUSE_QUERY_LIMITS,
        })) as { userId: unknown; votes: unknown }[];
        const userIds: number[] = [];
        const votes: number[] = [];
        for (const row of totals) {
          const userId = Number(row.userId);
          const count = Number(row.votes);
          if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(count))
            throw new Error('crucible_votes returned a malformed total');
          userIds.push(userId);
          votes.push(Math.min(count, 2147483647));
        }
        if (!userIds.length) return [];

        const found = await readPg.cancellableQuery<MilestoneCandidateRow>(
          `SELECT v."userId", m.key AS "milestoneKey", NULL::timestamp AS "achievedAt"
          FROM unnest($1::int[], $2::int[]) AS v("userId", votes)
          JOIN "CreatorMilestone" m ON m.key = ANY($3::text[]) AND v.votes >= m.threshold
          WHERE ${notHeld('v."userId"')}`,
          [userIds, votes, keys]
        );
        return found.result();
      },
    },
  ];
}

/**
 * Daily-challenge wins paid before the winners table existed (Nov 2024 to 2026-02-10) survive only as
 * Buzz ledger payments in this description format. The current format ('Challenge Winner Prize #N:
 * <title>') is left out: those wins are in the winners table. The date bound only prunes partitions.
 */
const LEDGER_WIN_FILTER = `date < '2026-03-01'
    AND match(description, '^Challenge Winner Prize [0-9]+: [0-9]{4}-[0-9]{2}-[0-9]{2}$')`;

export const ledgerWinsSql = `SELECT toAccountId AS userId,
    formatDateTime(min(date), '%Y-%m-%d %H:%i:%S', 'UTC') AS at
  FROM buzzTransactions
  WHERE toAccountId > 0 AND ${LEDGER_WIN_FILTER}
  GROUP BY toAccountId, description`;

export const ledgerWinCountSql = `SELECT count() AS wins FROM (
    SELECT description FROM buzzTransactions
    WHERE toAccountId = {userId:Int32} AND ${LEDGER_WIN_FILTER}
    GROUP BY description
  )`;

const LEDGER_AT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Compete wins span Postgres and the ClickHouse ledger, so they are found row by row. */
export function competeWinGroups(
  queryClickhouse: QueryClickhouse,
  registry: Record<string, MilestoneRegistryEntry> = creatorMilestoneRegistry
): RowDetectorGroup[] {
  const entries = Object.entries(registry).filter(([, entry]) => entry.detector === 'competeWins');
  if (!entries.length) return [];
  const [, first] = entries[0];
  const keys = entries.map(([key]) => key);
  const watermarkId = ['competeWins', first.launchedAt.toISOString()].join(':');
  return [
    {
      id: `${watermarkId}:${first.silent ? 'silent' : 'announced'}`,
      watermarkId,
      keys,
      launchedAt: first.launchedAt,
      silent: !!first.silent,
      timed: true,
      candidates: async (readPg) => {
        const ledger = (await queryClickhouse(ledgerWinsSql, {
          readonly: '1',
          ...CLICKHOUSE_QUERY_LIMITS,
        })) as { userId: unknown; at: unknown }[];
        const userIds: number[] = [];
        const dates: string[] = [];
        for (const row of ledger) {
          const userId = Number(row.userId);
          const at = typeof row.at === 'string' ? row.at : '';
          if (!Number.isSafeInteger(userId) || userId <= 0 || !LEDGER_AT.test(at))
            throw new Error('buzzTransactions returned a malformed challenge win');
          userIds.push(userId);
          dates.push(at);
        }

        // Each threshold is dated by the win that reached it. Ties on a date break by contest, so a
        // re-run picks the same win.
        const found = await readPg.cancellableQuery<MilestoneCandidateRow>(
          `SELECT r."userId", m.key AS "milestoneKey", r.at AT TIME ZONE 'UTC' AS "achievedAt"
          FROM (
            SELECT s."userId", s.at,
              row_number() OVER (PARTITION BY s."userId" ORDER BY s.at, s.contest) AS n
            FROM (
              ${competeWinsSource}
              UNION ALL
              SELECT l."userId", l.at, 'ledger:' || l.ord
              FROM unnest($1::int[], $2::timestamp[]) WITH ORDINALITY AS l("userId", at, ord)
            ) s
          ) r
          JOIN "CreatorMilestone" m ON m.key = ANY($3::text[]) AND m.threshold = r.n
          WHERE ${notHeld('r."userId"')}`,
          [userIds, dates, keys]
        );
        return found.result();
      },
    },
  ];
}
