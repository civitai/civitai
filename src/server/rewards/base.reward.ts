import { ClickHouseClient } from '@clickhouse/client';
import { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { rewardFailedCounter, rewardGivenCounter } from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany, getMultipliersForUser } from '~/server/services/buzz.service';
import { hashifyObject } from '~/utils/string-helpers';
import { withRetries } from '../utils/errorHandling';

const log = (event: BuzzEventLog, data: MixedObject) => {
  logToAxiom({
    name: 'buzz-rewards',
    type: 'error',
    event: JSON.stringify(event),
    ...data,
  }).catch();
};

export function createBuzzEvent<T>({
  type,
  description,
  awardAmount,
  getKey,
  visible = true,
  ...buzzEvent
}: ProcessableBuzzEventDefinition<T> | OnEventBuzzEventDefinition<T>) {
  const isOnDemand = 'onDemand' in buzzEvent;
  const isProcessable = !isOnDemand;
  const types = [type];
  if (isProcessable) types.push(...(buzzEvent.includeTypes ?? []));

  const getUserRewardDetails = async (userId: number) => {
    const data = {
      // We'll return the event details
      // so that they can be presented on the UI.
      type,
      awardAmount,
      description,
      onDemand: isOnDemand,
      cap:
        'cap' in buzzEvent
          ? buzzEvent.cap
          : 'caps' in buzzEvent
          ? buzzEvent.caps?.filter((cap) => !!cap.interval)?.[0]?.amount
          : undefined,
      interval:
        'caps' in buzzEvent
          ? buzzEvent.caps?.filter((cap) => !!cap.interval)?.[0]?.interval
          : undefined,
      triggerDescription: buzzEvent.triggerDescription,
      tooltip: buzzEvent.tooltip,
      // -1 determines that this award is not on demand, as such, would require a full
      // clickhouse query to determine the awarded amount. For the time being, this won't be
      // done.
      awarded: -1,
    };

    // Apply multipliers
    const { rewardsMultiplier } = await getMultipliersForUser(userId);
    if (rewardsMultiplier !== 1) {
      data.awardAmount = Math.ceil(rewardsMultiplier * data.awardAmount);
      if (data.cap) data.cap = Math.ceil(rewardsMultiplier * data.cap);
    }

    if (!isOnDemand) {
      return data;
    }

    /**
     * NOTE: Based on discussion with Justin, this might be too expensive to do on demand.
     *       We'll need to revisit this in the future.
      const awarded = data.cap
        ? (await clickhouse
            ?.query({
              query: `
                SELECT COUNT(*) AS total
                FROM buzzEvents
                WHERE type like '${type}%'
                AND status = 'awarded'
                ${
                  data.interval === 'month'
                    ? 'AND time > toStartOfMonth(today())'
                    : data.interval === 'week'
                    ? 'AND time > toStartOfWeek(today())'
                    : 'AND time > today()'
                }
                AND toUserId = ${userId}
              `,
              format: 'JSONEachRow',
            })
            .then((x) => x.json<{ total: number }[]>())) ?? []
        : [];
     */

    const typeCacheJson = (await redis.hGet(REDIS_KEYS.BUZZ_EVENTS, `${userId}:${type}`)) ?? '{}';
    const typeCache = JSON.parse(typeCacheJson);
    const eventCount = Object.keys(typeCache).length;

    data.awarded = Math.min(eventCount * data.awardAmount, data.cap ?? Infinity);

    return data;
  };

  const sendAward = async (events: BuzzEventLog[]) => {
    await withRetries(() =>
      createBuzzTransactionMany(
        events
          .filter((x) => x.awardAmount > 0)
          .map((event) => {
            if (event.multiplier === 0) event.multiplier = 1;
            return {
              type: TransactionType.Reward,
              toAccountId: event.toUserId,
              fromAccountId: 0, // central bank
              amount: Math.ceil(event.awardAmount * (event.multiplier ?? 1)),
              description: `Buzz Reward: ${description}`,
              details: {
                type: event.type,
                forId: event.forId,
                byUserId: event.byUserId,
                ...JSON.parse(event?.transactionDetails ?? '{}'),
              },
              externalTransactionId:
                event.type === 'userReferred' || event.type === 'refereeCreated'
                  ? `${event.type}:${event.forId}-${event.ip}`
                  : `${event.type}:${event.forId}-${event.toUserId}-${event.byUserId}`,
            };
          })
      )
    );
  };

  const processOnDemand = async (key: BuzzEventKey) => {
    if (!isOnDemand) return false;

    // Get daily cache for user
    const typeCacheJson =
      (await redis.hGet(REDIS_KEYS.BUZZ_EVENTS, `${key.toUserId}:${type}`)) ?? '{}';
    const typeCache = JSON.parse(typeCacheJson);
    const cacheKey = hashifyObject(key);

    // Check if already awarded
    const hasAlreadyAwarded = typeCache[cacheKey];
    if (hasAlreadyAwarded) return false;

    // Determine amount to award
    const awarded = Object.keys(typeCache).length * awardAmount;
    const cap = buzzEvent.cap ?? Infinity;
    const remaining = Math.max(cap - awarded, 0);
    const toAward = Math.min(awardAmount, remaining);

    // Update cache
    typeCache[cacheKey] = Date.now().toString();
    await redis.hSet(REDIS_KEYS.BUZZ_EVENTS, `${key.toUserId}:${type}`, JSON.stringify(typeCache));

    return toAward;
  };

  const apply = async (input: T, ip?: string) => {
    if (!clickhouse) return;
    const definedKey = await getKey(input, { ch: clickhouse, db: dbWrite });
    if (!definedKey) return;

    const { rewardsMultiplier } = await getMultipliersForUser(definedKey.toUserId);

    const transactionDetails = buzzEvent.getTransactionDetails
      ? await buzzEvent.getTransactionDetails(input, { ch: clickhouse, db: dbWrite })
      : undefined;

    const key = { type, ...definedKey } as BuzzEventKey;
    const event: BuzzEventLog = {
      ...key,
      awardAmount,
      multiplier: rewardsMultiplier,
      status: 'pending',
      ip: ['::1', ''].includes(ip ?? '') ? undefined : ip,
      transactionDetails: JSON.stringify(transactionDetails ?? {}),
    };

    if (isOnDemand) {
      const toAward = await processOnDemand(key);
      if (toAward === false) return; // already awarded

      event.status = toAward > 0 ? 'awarded' : 'capped';
      event.awardAmount = toAward;
    }

    try {
      await addBuzzEvent(event);
    } catch (error) {
      log(event, { message: 'Failed to record buzz event', error });
      rewardFailedCounter.inc();
      throw new Error(`Failed to record buzz event: ${error}`);
    }

    if (event.status === 'awarded') {
      try {
        await sendAward([event]);
        rewardGivenCounter.inc();
      } catch (error) {
        log(event, {
          message: 'Failed to send award for buzz event',
          error,
        });
        rewardFailedCounter.inc();
        throw new Error(
          `Failed to send award for buzz event: ${error}.\n\nTransaction: ${JSON.stringify(event)}`
        );
      }
    }
  };

  const process = async (ctx: ProcessingContext) => {
    if (!isProcessable || !clickhouse) return;
    await buzzEvent.preprocess?.(ctx);
    const targeted = ctx.toProcess.filter((event) => event.status !== 'unqualified');

    // Get previously awarded amounts for things we're processing
    // As dictated by caps we apply
    const prevAwards: Record<string, number> = {};
    if (buzzEvent.caps) {
      for (const { keyParts, interval } of buzzEvent.caps) {
        const ids = new Set<string>();
        for (const event of targeted) {
          const key = keyParts.map((keyPart) => event[keyPart]).join(',');
          ids.add(key);
        }

        const idTuples = [...ids].map((id) => `(${id})`).join(', ');
        const data = await clickhouse.$query<CapResult>`
          SELECT ${keyParts.join(', ')}, SUM(awardAmount) AS total
          FROM buzzEvents
          WHERE type IN (${types.map((x) => `'${x}'`).join(', ')})
            AND status = 'awarded'
            ${
              !interval
                ? ''
                : interval === 'day'
                ? 'AND time > today()'
                : `AND time > now() - INTERVAL '1 ${interval}'`
            }
            AND (${keyParts.join(', ')}) IN (${idTuples})
          GROUP BY ${keyParts.join(', ')}
        `;
        for (const row of data) {
          const key = computeCapKey({ keyParts, interval, data: row });
          prevAwards[key] = row.total;
        }
      }
    }

    // prepare awards for allocation
    for (const event of targeted) {
      // check against caps
      const prevAwardKeys = new Set<string>();
      if (buzzEvent.caps) {
        for (const { keyParts, interval, amount } of buzzEvent.caps) {
          // Get previously awarded
          const key = computeCapKey({ keyParts, interval, data: event });
          prevAwardKeys.add(key);
          const prevAward = prevAwards[key] ?? 0;

          // Determine amount remaining against cap
          const remaining = Math.max(amount - prevAward, 0);
          event.awardAmount = Math.min(event.awardAmount, remaining);
        }
      }

      // Handle award
      if (event.awardAmount > 0) {
        event.status = 'awarded';
        // Add the award to the prev awards for subsequent processing
        for (const keys of prevAwardKeys) prevAwards[keys] += event.awardAmount;
      } else {
        event.status = 'capped';
      }
    }

    // Update buzz event and send awards in chunks
    const chunks = chunk(ctx.toProcess, 1000);
    let transactionStatus: 'update' | 'send' = 'update';
    for (const chunk of chunks) {
      try {
        // Update in clickhouse
        transactionStatus = 'update';
        await updateBuzzEvents(chunk);

        // Send buzz awards
        transactionStatus = 'send';
        await sendAward(chunk);
      } catch (error) {
        // If we failed while sending, we need to reset the events
        if (transactionStatus === 'send') {
          for (const event of chunk) {
            if (event.status !== 'unqualified') {
              event.status = 'pending';
              event.awardAmount = awardAmount;
            }
          }
          await updateBuzzEvents(chunk);
        }

        // Then throw the error
        throw new Error(
          `Buzz Event Processing Failure: Failed to ${transactionStatus} buzz events for ${type}`,
          {
            cause: (error as any).message,
          }
        );
      }
    }
  };

  return {
    types,
    visible,
    apply,
    process,
    getUserRewardDetails,
  };
}

// TODO: sometimes this can cause duplicate entries.
//  hypothesis is that this occurs due to a combination of
//  async inserts + ch's merge strategy
async function addBuzzEvent(event: BuzzEventLog) {
  withRetries(
    async () =>
      await clickhouse?.insert({
        table: 'buzzEvents',
        values: [event],
        format: 'JSONEachRow',
      }),
    5,
    500
  );
}

async function updateBuzzEvents(events: BuzzEventLog[]) {
  for (const event of events) event.version = (event.version ?? 0) + 1;
  withRetries(
    async () =>
      await clickhouse?.insert({
        table: 'buzzEvents',
        values: events,
        format: 'JSONEachRow',
      }),
    5,
    500
  );
}

type CapResult = { [k: string]: number; total: number };
function computeCapKey(x: {
  keyParts: (keyof BuzzEventKey)[];
  interval?: CapInterval;
  data: Record<string, any>;
}) {
  let capKey = x.keyParts.map((keyPart) => x.data[keyPart]).join(',');
  if (x.interval) capKey += `,${x.interval}`;
  return capKey;
}

export type BuzzEvent = ReturnType<typeof createBuzzEvent>;

type BuzzEventKey = {
  type: string;
  toUserId: number;
  forId: number | string;
  byUserId: number;
};

export type BuzzEventLog = BuzzEventKey & {
  awardAmount: number;
  multiplier?: number;
  status?: 'pending' | 'awarded' | 'capped' | 'unqualified';
  ip?: string;
  version?: number;
  transactionDetails?: string;
};

type ProcessingContext = {
  toProcess: BuzzEventLog[];
  lastUpdate: Date;
  ch: ClickHouseClient;
  db: PrismaClient;
};

type GetKeyContext = {
  ch: ClickHouseClient;
  db: PrismaClient;
};

type GetKeyOutput = Omit<BuzzEventKey, 'type'> & { type?: BuzzEventKey['type'] };
type BuzzEventDefinitionBase<T> = {
  type: string;
  description: string;
  awardAmount: number;
  triggerDescription?: string;
  tooltip?: string;
  visible?: boolean;
  getKey: (input: T, ctx: GetKeyContext) => Promise<GetKeyOutput | false>;
  getTransactionDetails?: (input: T, ctx: GetKeyContext) => Promise<MixedObject | undefined>;
};

type CapInterval = 'day' | 'week' | 'month';
type ProcessableBuzzEventDefinition<T> = BuzzEventDefinitionBase<T> & {
  includeTypes?: string[];
  caps?: {
    keyParts: (keyof BuzzEventKey)[];
    amount: number;
    interval?: CapInterval;
  }[];
  preprocess?: (ctx: ProcessingContext) => Promise<void>;
};

type OnEventBuzzEventDefinition<T> = BuzzEventDefinitionBase<T> & {
  cap?: number;
  // On demand items are kept in redis cache and awarded instantly.
  // Cache is cleared daily and is set on a per-user basis.
  onDemand: true;
};
