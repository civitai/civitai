import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import type {
  EarningsBreakdown,
  EarningsThisMonth,
  GetModelPerformanceInput,
  GetSourceMixInput,
  ModelPerformanceRow,
  ModelTrend,
  SourceMixRow,
} from '~/server/schema/creator-earnings.schema';

// Phase A: 1000 Buzz = $1.00 (rough internal display rate; tooltip caveats this).
// Tracked separately from the cash-out program's pool calculation; this is a
// presentation-only number.
const BUZZ_TO_USD_RATE = 1 / 1000;

const emptyBreakdown = (): EarningsBreakdown => ({
  creatorsTip: 0,
  tipConfirm: 0,
  ea: 0,
  bounty: 0,
  other: 0,
});

const sumBreakdown = (b: EarningsBreakdown) =>
  b.creatorsTip + b.tipConfirm + b.ea + b.bounty + b.other;

const buzzToUsd = (buzz: number) => Math.round(buzz * BUZZ_TO_USD_RATE * 100) / 100;

const computeTrend = (current: number, prior: number): ModelTrend => {
  if (current === 0 && prior === 0) return 'dead';
  if (current === 0) return 'down';
  if (prior === 0) return 'up';
  const delta = (current - prior) / prior;
  if (delta > 0.05) return 'up';
  if (delta < -0.05) return 'down';
  return 'flat';
};

type CreatorModelRow = {
  modelId: number;
  modelName: string;
  modelType: string;
  earlyAccessDeadline: Date | null;
  modelVersionIds: number[];
};

async function getCreatorModels(userId: number): Promise<CreatorModelRow[]> {
  const models = await dbRead.model.findMany({
    where: {
      userId,
      deletedAt: null,
      status: 'Published',
    },
    select: {
      id: true,
      name: true,
      type: true,
      earlyAccessDeadline: true,
      modelVersions: {
        where: { status: 'Published' },
        select: { id: true },
      },
    },
  });

  return models
    .map((m) => ({
      modelId: m.id,
      modelName: m.name,
      modelType: m.type,
      earlyAccessDeadline: m.earlyAccessDeadline,
      modelVersionIds: m.modelVersions.map((v) => v.id),
    }))
    .filter((m) => m.modelVersionIds.length > 0);
}

async function getCreatorModelVersionIds(userId: number): Promise<number[]> {
  const models = await getCreatorModels(userId);
  return models.flatMap((m) => m.modelVersionIds);
}

type MonthlyAggregate = {
  current: EarningsBreakdown;
  prior: EarningsBreakdown;
};

async function queryMonthlyAggregate(
  userId: number,
  modelVersionIds: number[]
): Promise<MonthlyAggregate> {
  const result: MonthlyAggregate = { current: emptyBreakdown(), prior: emptyBreakdown() };
  if (!clickhouse) return result;

  // We query the prior 2 full calendar months + current month-to-date.
  // ClickHouse bucketizes by toStartOfMonth to bucket-merge in SQL rather
  // than in Node.
  const promises: Promise<void>[] = [];

  // creatorsTip from orchestration.jobs (only if the creator has any
  // ModelVersions; otherwise the IN list would be empty and the join becomes
  // a no-op).
  if (modelVersionIds.length > 0) {
    promises.push(
      (async () => {
        const rows = await clickhouse!.$query<{ bucket: string; amount: number }>`
          SELECT
            toString(toStartOfMonth(createdAt)) AS bucket,
            sum(creatorsTip) AS amount
          FROM orchestration.jobs
          WHERE createdAt >= toStartOfMonth(subtractMonths(now(), 1))
            AND creatorsTip > 0
            AND arrayExists(x -> x IN (${modelVersionIds}), resourcesUsed)
          GROUP BY bucket
        `;
        applyBucketed(rows, 'creatorsTip', result);
      })()
    );
  }

  // Direct tips via default.actions Tip_Confirm
  promises.push(
    (async () => {
      const rows = await clickhouse!.$query<{ bucket: string; amount: number }>`
        SELECT
          toString(toStartOfMonth(time)) AS bucket,
          sum(toFloat64OrZero(JSONExtractRaw(details, 'amount'))) AS amount
        FROM default.actions
        WHERE type = 'Tip_Confirm'
          AND time >= toStartOfMonth(subtractMonths(now(), 1))
          AND toUInt32OrZero(JSONExtractRaw(details, 'toUserId')) = ${userId}
      `;
      applyBucketed(rows, 'tipConfirm', result);
    })()
  );

  // EA + bounty + other from buzzTransactions
  promises.push(
    (async () => {
      const rows = await clickhouse!.$query<{
        bucket: string;
        category: 'ea' | 'bounty' | 'other';
        amount: number;
      }>`
        SELECT
          toString(toStartOfMonth(date)) AS bucket,
          multiIf(
            type = 'purchase' AND fromAccountId != 0, 'ea',
            description LIKE 'Bounty award%', 'bounty',
            'other'
          ) AS category,
          sum(toFloat64(amount)) AS amount
        FROM buzzTransactions
        WHERE toAccountId = ${userId}
          AND toAccountType = 'yellow'
          AND date >= toStartOfMonth(subtractMonths(now(), 1))
          AND (
            (type = 'purchase' AND fromAccountId != 0)
            OR description LIKE 'Bounty award%'
            OR type = 'compensation'
          )
        GROUP BY bucket, category
      `;
      for (const row of rows) {
        const target = bucketTarget(row.bucket, result);
        if (!target) continue;
        const cat: keyof EarningsBreakdown = row.category;
        target[cat] += Number(row.amount) || 0;
      }
    })()
  );

  await Promise.all(promises);
  return result;
}

function bucketTarget(bucket: string, result: MonthlyAggregate): EarningsBreakdown | undefined {
  // bucket is `YYYY-MM-DD HH:mm:ss` from ClickHouse toString(toStartOfMonth(...))
  const bucketDate = new Date(bucket.replace(' ', 'T') + 'Z');
  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const priorMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  if (bucketDate.getTime() === currentMonthStart.getTime()) return result.current;
  if (bucketDate.getTime() === priorMonthStart.getTime()) return result.prior;
  return undefined;
}

function applyBucketed(
  rows: { bucket: string; amount: number }[],
  key: keyof EarningsBreakdown,
  result: MonthlyAggregate
) {
  for (const row of rows) {
    const target = bucketTarget(row.bucket, result);
    if (!target) continue;
    target[key] += Number(row.amount) || 0;
  }
}

export async function getEarningsThisMonth({
  userId,
}: {
  userId: number;
}): Promise<EarningsThisMonth> {
  return fetchThroughCache(
    `${REDIS_KEYS.CREATOR_EARNINGS.THIS_MONTH}:${userId}`,
    async () => {
      const modelVersionIds = await getCreatorModelVersionIds(userId);
      const { current, prior } = await queryMonthlyAggregate(userId, modelVersionIds);
      const currentTotal = sumBreakdown(current);
      const priorTotal = sumBreakdown(prior);
      return {
        currentMonth: {
          totalBuzz: Math.floor(currentTotal),
          usdEquivalent: buzzToUsd(currentTotal),
          breakdown: floorBreakdown(current),
        },
        priorMonth: {
          totalBuzz: Math.floor(priorTotal),
          usdEquivalent: buzzToUsd(priorTotal),
          breakdown: floorBreakdown(prior),
        },
      };
    },
    { ttl: CacheTTL.sm }
  );
}

function floorBreakdown(b: EarningsBreakdown): EarningsBreakdown {
  return {
    creatorsTip: Math.floor(b.creatorsTip),
    tipConfirm: Math.floor(b.tipConfirm),
    ea: Math.floor(b.ea),
    bounty: Math.floor(b.bounty),
    other: Math.floor(b.other),
  };
}

async function querySourceMix30d(
  userId: number,
  modelVersionIds: number[]
): Promise<EarningsBreakdown> {
  const result = emptyBreakdown();
  if (!clickhouse) return result;

  const promises: Promise<void>[] = [];

  if (modelVersionIds.length > 0) {
    promises.push(
      (async () => {
        const rows = await clickhouse!.$query<{ amount: number }>`
          SELECT sum(creatorsTip) AS amount
          FROM orchestration.jobs
          WHERE createdAt > subtractDays(now(), 30)
            AND creatorsTip > 0
            AND arrayExists(x -> x IN (${modelVersionIds}), resourcesUsed)
        `;
        result.creatorsTip = Number(rows[0]?.amount) || 0;
      })()
    );
  }

  promises.push(
    (async () => {
      const rows = await clickhouse!.$query<{ amount: number }>`
        SELECT sum(toFloat64OrZero(JSONExtractRaw(details, 'amount'))) AS amount
        FROM default.actions
        WHERE type = 'Tip_Confirm'
          AND time > subtractDays(now(), 30)
          AND toUInt32OrZero(JSONExtractRaw(details, 'toUserId')) = ${userId}
      `;
      result.tipConfirm = Number(rows[0]?.amount) || 0;
    })()
  );

  promises.push(
    (async () => {
      const rows = await clickhouse!.$query<{
        category: 'ea' | 'bounty' | 'other';
        amount: number;
      }>`
        SELECT
          multiIf(
            type = 'purchase' AND fromAccountId != 0, 'ea',
            description LIKE 'Bounty award%', 'bounty',
            'other'
          ) AS category,
          sum(toFloat64(amount)) AS amount
        FROM buzzTransactions
        WHERE toAccountId = ${userId}
          AND toAccountType = 'yellow'
          AND date > subtractDays(now(), 30)
          AND (
            (type = 'purchase' AND fromAccountId != 0)
            OR description LIKE 'Bounty award%'
            OR type = 'compensation'
          )
        GROUP BY category
      `;
      for (const row of rows) {
        const cat: keyof EarningsBreakdown = row.category;
        result[cat] += Number(row.amount) || 0;
      }
    })()
  );

  await Promise.all(promises);
  return result;
}

export async function getSourceMix({
  userId,
}: {
  userId: number;
} & GetSourceMixInput): Promise<SourceMixRow[]> {
  return fetchThroughCache(
    `${REDIS_KEYS.CREATOR_EARNINGS.SOURCE_MIX}:${userId}`,
    async () => {
      const modelVersionIds = await getCreatorModelVersionIds(userId);
      const mix = await querySourceMix30d(userId, modelVersionIds);
      const total = sumBreakdown(mix);
      const rows: SourceMixRow[] = (
        ['creatorsTip', 'tipConfirm', 'ea', 'bounty', 'other'] as const
      ).map((source) => {
        const buzz = Math.floor(mix[source]);
        const pct = total > 0 ? Math.round((mix[source] / total) * 1000) / 10 : 0;
        return { source, buzz, pct };
      });
      return rows;
    },
    { ttl: CacheTTL.sm }
  );
}

type PerVersionRow = {
  modelVersionId: number;
  jobsCurrent: number;
  jobsPrior: number;
  buzzCurrent: number;
  buzzPrior: number;
};

async function queryPerVersionPerformance(
  modelVersionIds: number[]
): Promise<Map<number, PerVersionRow>> {
  const map = new Map<number, PerVersionRow>();
  if (!clickhouse || modelVersionIds.length === 0) return map;

  // 60-day window split into current (last 30d) + prior (30-60d ago).
  // arrayJoin(resourcesUsed) is the canonical pattern from getEarnPotential —
  // it gives one row per (job, resource) so we can attribute per-resource and
  // then aggregate up to modelVersionId.
  const rows = await clickhouse.$query<{
    modelVersionId: number;
    period: 'current' | 'prior';
    jobs: number;
    buzz: number;
  }>`
    WITH resource_jobs AS (
      SELECT
        arrayJoin(resourcesUsed) AS modelVersionId,
        jobId,
        createdAt,
        creatorsTip
      FROM orchestration.jobs
      WHERE createdAt > subtractDays(now(), 60)
        AND arrayExists(x -> x IN (${modelVersionIds}), resourcesUsed)
    )
    SELECT
      modelVersionId,
      if(createdAt > subtractDays(now(), 30), 'current', 'prior') AS period,
      uniq(jobId) AS jobs,
      sum(creatorsTip) AS buzz
    FROM resource_jobs
    WHERE modelVersionId IN (${modelVersionIds})
    GROUP BY modelVersionId, period
  `;

  for (const row of rows) {
    const entry = map.get(row.modelVersionId) ?? {
      modelVersionId: row.modelVersionId,
      jobsCurrent: 0,
      jobsPrior: 0,
      buzzCurrent: 0,
      buzzPrior: 0,
    };
    if (row.period === 'current') {
      entry.jobsCurrent = Number(row.jobs) || 0;
      entry.buzzCurrent = Number(row.buzz) || 0;
    } else {
      entry.jobsPrior = Number(row.jobs) || 0;
      entry.buzzPrior = Number(row.buzz) || 0;
    }
    map.set(row.modelVersionId, entry);
  }

  return map;
}

export async function getModelPerformance({
  userId,
  sortBy,
}: {
  userId: number;
} & GetModelPerformanceInput): Promise<ModelPerformanceRow[]> {
  return fetchThroughCache(
    `${REDIS_KEYS.CREATOR_EARNINGS.MODEL_PERFORMANCE}:${userId}:${sortBy}`,
    async () => {
      const models = await getCreatorModels(userId);
      if (models.length === 0) return [];

      const allVersionIds = models.flatMap((m) => m.modelVersionIds);
      const perVersion = await queryPerVersionPerformance(allVersionIds);

      const now = new Date();
      const rows: ModelPerformanceRow[] = models.map((model) => {
        let jobsCurrent = 0;
        let buzzCurrent = 0;
        let buzzPrior = 0;
        for (const vid of model.modelVersionIds) {
          const v = perVersion.get(vid);
          if (!v) continue;
          jobsCurrent += v.jobsCurrent;
          buzzCurrent += v.buzzCurrent;
          buzzPrior += v.buzzPrior;
        }
        const eaEnabled = model.earlyAccessDeadline !== null && model.earlyAccessDeadline > now;
        return {
          modelId: model.modelId,
          modelName: model.modelName,
          modelType: model.modelType,
          jobsCount: Math.floor(jobsCurrent),
          buzzEarned: Math.floor(buzzCurrent),
          trend: computeTrend(buzzCurrent, buzzPrior),
          eaEnabled,
        };
      });

      const sortKey: keyof ModelPerformanceRow =
        sortBy === 'jobsCount' ? 'jobsCount' : 'buzzEarned';
      rows.sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number));
      return rows;
    },
    { ttl: CacheTTL.sm }
  );
}
