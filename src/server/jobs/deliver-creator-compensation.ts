import { chunk, isEmpty } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';
import { createJob, getJobDate } from './job';
import { Prisma } from '@prisma/client';
import { withRetries } from '~/server/utils/errorHandling';
import dayjs from 'dayjs';
import { formatDate } from '~/utils/date-helpers';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';

const IMAGE_CREATOR_COMP = 0.25;
const VIDEO_CREATOR_COMP = 0.1;
const BASE_MODEL_COMP = 0.25;
const COMPENSATION_BATCH_SIZE = 1000;

type CompensationRecord = {
  date: Date;
  modelVersionId: number;
  comp: number;
  tip: number;
  total: number;
  count: number;
  final: number;
};

export const updateCreatorResourceCompensation = createJob(
  'update-creator-resource-compensation',
  '15 * * * *', // Run 15 minutes after the hour to ensure jobs from the prior hour are completed
  async () => {
    if (!clickhouse) return;

    // If it's a new day, we need to run the compensation payout job
    const [lastPayout, setLastPayout] = await getJobDate(
      'run-daily-compensation-payout',
      new Date()
    );
    const shouldPayout = dayjs(lastPayout).isBefore(dayjs().startOf('day'));

    // If we're preping for payout, we need to grab the last numbers for yesterday.
    const subtractDays = shouldPayout ? 1 : 0;
    const addDays = 1;

    console.log('Fetching compensation records...');

    // Step 1: Fetch all compensation records with optimized query
    const records = await clickhouse.$query<CompensationRecord>`
      SELECT
        toStartOfDay(createdAt) as date,
        modelVersionId,
        FLOOR(SUM(comp)) as comp,
        FLOOR(SUM(tip)) AS tip,
        comp + tip as total,
        count(*) as count,
        date < toStartOfDay(now()) as final
      FROM (
        SELECT
        modelVersionId,
        createdAt,
        max(jobCost) * (if(isVideo, ${VIDEO_CREATOR_COMP}, ${IMAGE_CREATOR_COMP})) as creator_comp,
        max(creatorsTip) as full_tip,
        max(resource_count) as resource_count,
        creator_comp * if(max(isBaseModel) = 1, ${BASE_MODEL_COMP}, 0) as base_model_comp,
        creator_comp * ${1 - BASE_MODEL_COMP} / resource_count as resource_comp,
        base_model_comp + resource_comp as comp,
        full_tip / resource_count as tip,
        comp + tip as total
        FROM (
          SELECT
            rj.modelVersionId as modelVersionId,
            rj.resource_count as resource_count,
            rj.createdAt as createdAt,
            rj.jobCost as jobCost,
            rj.jobId as jobId,
            rj.creatorsTip as creatorsTip,
            m.type = 'Checkpoint' as isBaseModel,
            rj.isVideo as isVideo
          FROM (
            SELECT
              arrayJoin(arrayFilter(x -> x NOT IN (250708, 250712, 106916), resourcesUsed)) AS modelVersionId,
              length(arrayFilter(x -> x NOT IN (250708, 250712, 106916), resourcesUsed)) as resource_count,
              createdAt,
              cost as jobCost,
              jobId,
              creatorsTip,
              jobType = 'comfyVideoGen' as isVideo
            FROM orchestration.jobs
            WHERE jobType IN ('TextToImageV2', 'comfyVideoGen')
              AND createdAt BETWEEN toStartOfDay(subtractDays(now(),${subtractDays})) AND toStartOfDay(addDays(now(),${addDays}))
              AND cost > 0
          ) rj
          GLOBAL JOIN civitai_pg.ModelVersion mv ON mv.id = rj.modelVersionId
          GLOBAL JOIN civitai_pg.Model m ON m.id = mv.modelId
        ) resource_job_details
        GROUP BY modelVersionId, jobId, createdAt, isVideo
      ) resource_job_values
      GROUP BY date, modelVersionId
      HAVING total >= 1
      ORDER BY total DESC
    `;

    console.log(`Fetched ${records.length} compensation records. Inserting in batches...`);

    // Step 2: Insert records in batches to avoid timeout
    const batches = chunk(records, COMPENSATION_BATCH_SIZE);
    const totalBatches = batches.length;
    let batchCount = 0;

    for (const batch of batches) {
      const values = batch
        .map(
          (r) =>
            `(toDate('${formatDate(r.date, 'YYYY-MM-DD')}'), ${r.modelVersionId}, ${r.comp}, ${
              r.tip
            }, ${r.total}, ${r.count}, ${r.final})`
        )
        .join(',');

      await clickhouse.$query`
        INSERT INTO buzz_resource_compensation (date, modelVersionId, comp, tip, total, count, final)
        VALUES ${values};
      `;
      batchCount++;

      console.log(`Inserted batch ${batchCount}/${totalBatches} (${batch.length} records)`);
    }

    console.log(`Successfully inserted ${records.length} compensation records`);

    if (shouldPayout) {
      await runPayout(lastPayout);
      await setLastPayout();
      try {
        await clickhouse.$query`
          INSERT INTO kafka.manual_events VALUES
            (now(), 'update-compensation', '{"date":"${formatDate(lastPayout, 'YYYY-MM-DD')}"}');
        `;
      } catch (error) {
        console.error('Error queueing compensation update event', error);
      }
    }
  }
);

type UserVersions = { userId: number; modelVersionIds: number[] };
type Compensation = { modelVersionId: number; amount: number; accountType: BuzzAccountType };

const BATCH_SIZE = 100;
const COMP_START_DATE = new Date('2024-08-01');

export async function runPayout(lastUpdate: Date) {
  if (!clickhouse) return;
  if (lastUpdate < COMP_START_DATE) return;

  const date = dayjs.utc(lastUpdate).startOf('day').toDate();
  const compensations = await clickhouse.$query<Compensation>`
    SELECT
      modelVersionId,
	    accountType,
	    MAX(FLOOR(amount))::int AS amount
    FROM orchestration.resourceCompensations
    WHERE date = ${date}
    GROUP BY modelVersionId, accountType
    HAVING amount > 0;
  `;
  if (!compensations.length) return;

  const creatorsToPay: Record<number, Compensation[]> = {};
  const batches = chunk(compensations, BATCH_SIZE);
  for (const batch of batches) {
    const versionIds = batch.map((c) => c.modelVersionId);
    if (!versionIds.length) continue;

    const userVersions = await dbRead.$queryRaw<UserVersions[]>`
        SELECT
          m."userId" as "userId",
          array_agg(mv.id::int) as "modelVersionIds"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE mv.id IN (${Prisma.join(versionIds)})
        GROUP BY m."userId";
      `;

    for (const { userId, modelVersionIds } of userVersions) {
      if (!modelVersionIds.length || userId === -1) continue;

      if (!creatorsToPay[userId]) creatorsToPay[userId] = [];

      creatorsToPay[userId].push(
        ...batch.filter((c) => modelVersionIds.includes(c.modelVersionId))
      );
    }
  }
  if (isEmpty(creatorsToPay)) return;

  // Compensations and transactions are now one and the same.
  const compensationTransactions = Object.entries(creatorsToPay)
    .flatMap(([userId, compensations]) => {
      const groupedCompensations = compensations.reduce<Partial<Record<BuzzAccountType, number>>>(
        (acc, c) => {
          acc[c.accountType] = (acc[c.accountType] || 0) + c.amount;
          return acc;
        },
        {}
      );

      return Object.entries(groupedCompensations).map(([accountType, amount]) => ({
        fromAccountId: 0,
        toAccountId: Number(userId),
        fromAccountType: accountType as BuzzAccountType,
        toAccountType: accountType as BuzzAccountType,
        amount,
        description: `Creator tip compensation (${formatDate(date)})`,
        type: TransactionType.Compensation,
        externalTransactionId: `creator-tip-comp-${formatDate(
          date,
          'YYYY-MM-DD'
        )}-${userId}-${accountType}`,
      }));
    })
    .filter((transaction) => transaction.amount > 0);

  const tasks = [
    ...chunk(compensationTransactions, BATCH_SIZE).map((batch) => async () => {
      await withRetries(() => createBuzzTransactionMany(batch), 1);
    }),
  ];

  await limitConcurrency(tasks, 2);
}
