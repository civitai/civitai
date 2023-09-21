import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { ClickHouseClient } from '@clickhouse/client';
import { PrismaClient } from '@prisma/client';
import { redis } from '~/server/redis/client';
import { hashifyObject } from '~/utils/string-helpers';
import { chunk } from 'lodash';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';

export function createBuzzEvent<T>({
  type,
  description,
  awardAmount,
  getKey,
  ...buzzEvent
}: ProcessableBuzzEventDefinition<T> | OnEventBuzzEventDefinition<T>) {
  const isOnDemand = 'onDemand' in buzzEvent;
  const isProcessable = !isOnDemand;
  const types = [type];
  if (isProcessable) types.push(...(buzzEvent.includeTypes ?? []));

  const sendAward = async (events: BuzzEventLog | BuzzEventLog[]) => {
    if (!Array.isArray(events)) events = [events];

    await createBuzzTransactionMany(
      events
        .filter((x) => x.awardAmount > 0)
        .map((event) => ({
          type: TransactionType.Reward,
          toAccountId: event.toUserId,
          fromAccountId: 0, // central bank
          amount: event.awardAmount,
          description: `Buzz Reward: ${description}`,
          details: {
            type: event.type,
            forId: event.forId,
            byUserId: event.byUserId,
          },
        }))
    );
  };

  const processOnDemand = async (key: BuzzEventKey) => {
    if (!isOnDemand) return false;

    // Get daily cache for user
    const typeCacheJson = (await redis.hGet('buzz-events', `${key.toUserId}:${type}`)) ?? '{}';
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
    await redis.hSet('buzz-events', `${key.toUserId}:${type}`, JSON.stringify(typeCache));

    return toAward;
  };

  const apply = async (input: T, ip?: string) => {
    if (!clickhouse) return;
    const definedKey = await getKey(input, { ch: clickhouse, db: dbWrite });
    if (!definedKey) return;

    const key = { type, ...definedKey } as BuzzEventKey;
    const event: BuzzEventLog = {
      ...key,
      awardAmount,
      status: 'pending',
      ip: ['::1', ''].includes(ip ?? '') ? undefined : ip,
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
      throw new Error(`Failed to record buzz event: ${error}`);
    }

    if (event.status === 'awarded') {
      try {
        await sendAward(event);
      } catch (error) {
        throw new Error(`Failed to send award for buzz event: ${error}`);
      }
    }
  };

  const process = async (ctx: ProcessingContext) => {
    if (!isProcessable) return;
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
        const res = await clickhouse?.query({
          query: `
            SELECT ${keyParts.join(', ')}, SUM(awardAmount) AS total
            FROM buzzEvents
            WHERE type IN (${types.map((x) => `'${x}'`).join(', ')})
              AND status = 'awarded'
              ${
                !interval
                  ? ''
                  : interval === 'day'
                  ? 'AND time > TODAY()'
                  : `AND time > NOW() - INTERVAL '1 ${interval}'`
              }
              AND (${keyParts.join(', ')}) IN (${idTuples})
            GROUP BY ${keyParts.join(', ')}
          `,
          format: 'JSONEachRow',
        });
        const data = (await res?.json<CapResult[]>()) ?? [];
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
    apply,
    process,
  };
}

async function addBuzzEvent(event: BuzzEventLog) {
  return await clickhouse?.insert({
    table: 'buzzEvents',
    values: [event],
    format: 'JSONEachRow',
    query_params: {
      async_insert: 1,
      wait_for_async_insert: 1,
    },
  });
}

async function updateBuzzEvents(events: BuzzEventLog[]) {
  for (const event of events) event.version = (event.version ?? 0) + 1;
  return await clickhouse?.insert({
    table: 'buzzEvents',
    values: events,
    format: 'JSONEachRow',
  });
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
  forId: number;
  byUserId: number;
};

export type BuzzEventLog = BuzzEventKey & {
  awardAmount: number;
  status?: 'pending' | 'awarded' | 'capped' | 'unqualified';
  ip?: string;
  version?: number;
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

  getKey: (input: T, ctx: GetKeyContext) => Promise<GetKeyOutput | false>;
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
  onDemand: true;
};
