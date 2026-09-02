import { BUZZ_EVENTS_MAX_MULTIPLIER, clampBuzzEventMultiplier } from '@civitai/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';
import type { PrismaClient } from '@prisma/client';
import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  clickhouseFailSoftCounter,
  rewardFailedCounter,
  rewardGivenCounter,
} from '~/server/prom/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import type { BuzzAccountType, BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransactionMany, getMultipliersForUser } from '~/server/services/buzz.service';
import type { ResolvedRewardConfig, RewardConfig } from '~/server/rewards/reward-config';
import { resolveFromConfig, resolveRewardConfig } from '~/server/rewards/reward-config';
import { clampRewardMultiplier } from '~/server/rewards/multiplier';
import { hashify, hashifyObject } from '~/utils/string-helpers';
import { isClickHouseConnectionError, withRetries } from '../utils/errorHandling';

// Retry budget for the batch `process` (cron) path — can afford to block.
const BATCH_RETRY_COUNT = 5;
const BATCH_RETRY_DELAY = 500;
// Retry budget for the inline `apply` path, which runs synchronously inside user
// mutations. Keep it tight so a ClickHouse brownout can't block a user action for
// ~2.5s of retries: 1 retry (= 2 attempts) with a short backoff.
const INLINE_RETRY_COUNT = 1;
const INLINE_RETRY_DELAY = 200;

const log = (event: BuzzEventLog, data: MixedObject) => {
  logToAxiom({
    name: 'buzz-rewards',
    type: 'error',
    event: JSON.stringify(event),
    ...data,
  }).catch(() => null);
};

// Lua script for atomic on-demand reward processing.
// Eliminates race conditions by performing read-check-write in a single atomic Redis operation.
// KEYS[1] = hash key (buzz-events)
// ARGV[1] = hash field (userId:type)
// ARGV[2] = cache key (hashed event key for dedup)
// ARGV[3] = effective award amount (already multiplied)
// ARGV[4] = effective cap (already multiplied)
// ARGV[5] = end-of-day unix timestamp for hash expiry
//
// Each dedup entry stores WHAT IT PAID (`a:<amount>`), not a timestamp. Deriving
// the day's earnings as `entry count * the CURRENT award` instead means changing
// the award mid-day rewrites history: at award 2 and cap 100, a user capped out
// at 50 entries; drop the award to 1 to spend less and those same 50 entries
// re-price to 50 earned, freeing 50 more — a day total of 150 from an edit meant
// to reduce it. Entries written before this (timestamps) fall back to the old
// count-based reading for the rest of the day; `rewardsDailyReset` clears the
// hash at 00:00 UTC, after which every entry carries its own amount.
export const ON_DEMAND_REWARD_SCRIPT = `
  local cacheJson = redis.call('HGET', KEYS[1], ARGV[1])
  local cache = cjson.decode(cacheJson or '{}')

  -- Check if already awarded (dedup by cache key)
  if cache[ARGV[2]] then
    return -1
  end

  -- Sum what the day's entries actually paid, and enforce the cap against that
  local awarded = 0
  for _, entry in pairs(cache) do
    local paid = string.match(tostring(entry), '^a:(%d+)$')
    awarded = awarded + (paid and tonumber(paid) or tonumber(ARGV[3]))
  end
  local remaining = math.max(tonumber(ARGV[4]) - awarded, 0)
  local toAward = math.min(tonumber(ARGV[3]), remaining)

  -- Update cache with new entry
  cache[ARGV[2]] = 'a:' .. tostring(toAward)
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(cache))

  -- Set hash expiry to end of UTC day
  redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[5]))

  return toAward
`;

/** `a:<amount>` as written by the Lua; `undefined` for a legacy timestamp entry. */
function parseEntryAmount(entry: unknown): number | undefined {
  const match = /^a:(\d+)$/.exec(String(entry));
  return match ? Number(match[1]) : undefined;
}

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

  const capEntries = 'caps' in buzzEvent ? buzzEvent.caps ?? [] : [];
  // One number cannot say whether it means the daily cap or the monthly one, so
  // a multi-entry table refuses the override rather than guessing an entry.
  const capOverridable = isOnDemand || capEntries.length === 1;
  const defaultCap =
    'cap' in buzzEvent ? buzzEvent.cap : capEntries.length === 1 ? capEntries[0].amount : undefined;

  // One literal for both readers. `resolveConfig` is what pays and `describeConfig`
  // is what the operator is shown; a field added to one and not the other is the
  // drift this whole design exists to prevent, and TypeScript only catches it for
  // a required field.
  const configDefaults = { awardAmount, cap: defaultCap, capOverridable };
  const resolveConfig = () => resolveRewardConfig(type, configDefaults);

  const getUserRewardDetails = async (userId: number) => {
    const config = await resolveConfig();
    // A reward disabled at runtime must not stay advertised with an amount and
    // a cap that will never pay.
    if (!config.enabled) return null;

    const intervalCap = capEntries.filter((cap) => !!cap.interval)?.[0];
    const data = {
      // We'll return the event details
      // so that they can be presented on the UI.
      type,
      awardAmount: config.awardAmount,
      description,
      onDemand: isOnDemand,
      cap: config.cap ?? intervalCap?.amount,
      interval: intervalCap?.interval,
      triggerDescription: buzzEvent.triggerDescription,
      tooltip: buzzEvent.tooltip,
      // -1 determines that this award is not on demand, as such, would require a full
      // clickhouse query to determine the awarded amount. For the time being, this won't be
      // done.
      awarded: -1,
      // How many times the reward fired today, which is NOT derivable from
      // `awarded`: a grant the cap trimmed to zero happened but paid nothing.
      awardedCount: -1,
      accountType: buzzEvent.toAccountType ?? 'blue',
    };

    // The THIRD reader of this value. Display rather than money, but `getMultipliersForUser` can
    // return a non-finite product, and an advertised award of `Infinity` is still a bug.
    const { rewardsMultiplier } = await getMultipliersForUser(userId);
    const multiplier = clampRewardMultiplier(rewardsMultiplier);
    if (multiplier !== 1) {
      data.awardAmount = Math.ceil(multiplier * data.awardAmount);
      if (data.cap) data.cap = Math.ceil(multiplier * data.cap);
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

    // Read the same per-entry amounts the Lua enforces the cap against, or the
    // UI reports a different day total than the one being paid.
    const entries = Object.values(typeCache);
    data.awardedCount = entries.length;
    data.awarded = Math.min(
      entries.reduce<number>(
        (sum, entry) => sum + (parseEntryAmount(entry) ?? data.awardAmount),
        0
      ),
      data.cap ?? Infinity
    );

    return data;
  };

  const sendAward = async (events: BuzzEventLog[]) => {
    await withRetries(() =>
      createBuzzTransactionMany(
        events
          .map((event) => {
            return {
              type: TransactionType.Reward,
              toAccountId: event.toUserId,
              fromAccountId: 0, // central bank
              amount: Math.ceil(event.awardAmount * clampRewardMultiplier(event.multiplier ?? 1)),
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
              toAccountType: buzzEvent.toAccountType ?? 'yellow',
            };
          })
          // A zero multiplier is `getMultipliersForUser` reporting rewards-ineligibility, not a
          // missing value, so the amount it produces is the intended one. Filtering on the amount
          // rather than on `awardAmount` also keeps a 0-Buzz transaction off the ledger.
          .filter((transaction) => transaction.amount > 0)
      )
    );
  };

  const processOnDemand = async (
    key: BuzzEventKey,
    multiplier: number,
    config: ResolvedRewardConfig
  ) => {
    if (!isOnDemand) return false;

    const hashField = `${key.toUserId}:${type}`;
    const cacheKey = String(hashifyObject(key));
    // WHETHER to clamp: `getMultipliersForUser` floors its BASE and then multiplies by the bonus
    // without re-clamping the product, so it can hand this a non-finite value built from two finite
    // floored factors — see `can return a NON-FINITE multiplier` in
    // buzz.service.multiplier-floor.test.ts.
    //
    // WHERE, and this is the part that is easy to get wrong: clamping at `apply`'s read would close
    // the same case, but it normalises the value before `toClickhouseBuzzEvent` sees it and
    // destroys the `multiplierRaw` audit fidelity — see base.reward.forid.test.ts.
    const effective = clampRewardMultiplier(multiplier);
    const effectiveAward = Math.ceil(config.awardAmount * effective);
    // An uncapped reward needs a finite ceiling: `tonumber('Infinity')` is nil in
    // Lua, which would throw out of the script and into the user's mutation.
    const effectiveCap =
      config.cap === undefined ? Number.MAX_SAFE_INTEGER : Math.ceil(config.cap * effective);
    const endOfDay = Math.floor(new Date().setUTCHours(23, 59, 59, 999) / 1000);

    const result = (await redis.eval(ON_DEMAND_REWARD_SCRIPT, {
      keys: [REDIS_KEYS.BUZZ_EVENTS],
      arguments: [
        hashField,
        cacheKey,
        String(effectiveAward),
        String(effectiveCap),
        String(endOfDay),
      ],
    })) as number;

    if (result === -1) return false; // Already awarded
    // `toAward` is what the cap left, which is NOT always the full award.
    return { toAward: result, effectiveAward };
  };

  const apply = async (input: T, tracking?: { ip?: string }) => {
    if (!clickhouse) return;

    // Gate before `getKey`. A disabled reward must cost one early return, not a
    // getKey query, a multiplier lookup (Redis + DB), a Redis dedup script and a
    // ClickHouse insert — `orchestrator.router` calls this once per feedback
    // patch inside a live generation mutation.
    const config = await resolveConfig();
    if (!config.enabled) return;

    // Fail-soft (resolution): getKey / getMultipliersForUser / getTransactionDetails hit the DB/Redis/CH and
    // run SYNCHRONOUSLY inside the triggering user mutation (collection.saveItem, toggleFollow, post.update,
    // ...). A throw here — e.g. a getKey query that returns no rows and gets destructured — must NEVER 500
    // that mutation, so resolve inside a fail-soft envelope and skip the reward on failure. Safe: nothing is
    // committed until processOnDemand below (no dedup entry yet), so an early throw leaves no side effects and
    // no double-award. The grant path (addBuzzEvent / sendAward) is separately fail-soft further down.
    const resolved = await (async () => {
      const definedKey = await getKey(input, { ch: clickhouse, db: dbWrite });
      if (!definedKey) return null;
      const { rewardsMultiplier } = await getMultipliersForUser(definedKey.toUserId);
      const transactionDetails = buzzEvent.getTransactionDetails
        ? await buzzEvent.getTransactionDetails(input, { ch: clickhouse, db: dbWrite })
        : undefined;
      return { definedKey, rewardsMultiplier, transactionDetails };
    })().catch((error) => {
      logToAxiom({
        name: 'buzz-rewards',
        type: 'error',
        message: 'Reward resolution failed (fail-soft)',
        rewardType: type,
        error: (error as Error)?.message,
        stack: (error as Error)?.stack,
      }).catch(() => null);
      rewardFailedCounter?.inc?.();
      return null;
    });
    if (!resolved) return;
    const { definedKey, rewardsMultiplier, transactionDetails } = resolved;

    const { ip } = tracking ?? {};

    const key = { type, ...definedKey } as BuzzEventKey;
    const event: BuzzEventLog = {
      ...key,
      awardAmount: config.awardAmount,
      multiplier: rewardsMultiplier,
      status: 'pending',
      ip: ['::1', ''].includes(ip ?? '') ? undefined : ip,
      transactionDetails: JSON.stringify(transactionDetails ?? {}),
    };

    if (isOnDemand) {
      const outcome = await processOnDemand(key, rewardsMultiplier, config);
      if (outcome === false) return; // already awarded
      const { toAward, effectiveAward } = outcome;

      event.status = toAward > 0 ? 'awarded' : 'capped';
      if (event.status === 'capped') {
        event.awardAmount = 0;
      } else if (toAward < effectiveAward) {
        // The cap trimmed this grant. Paying the full award here is how an award
        // that does not divide its cap overshoots it — 34 grants of 3 against a
        // cap of 100 paid 102, and an operator raising the award above the cap
        // would pay the whole award on the first grant. `toAward` is already
        // multiplied, so record it whole and neutralise the multiplier rather
        // than applying it twice in `sendAward`.
        event.awardAmount = toAward;
        event.multiplier = 1;
      }
      // Otherwise keep the base awardAmount and multiplier for ClickHouse
      // storage consistency; processOnDemand enforced the cap on the multiplied
      // values and this grant was not trimmed.
    }

    // Fail-soft: the inline `apply` path runs synchronously inside user mutations
    // (toggleFollow, post.update, collection.saveItem, claimDailyBoostReward, ...).
    // The ClickHouse `buzzEvents` insert is an AUDIT/analytics row — it does NOT
    // move money. The actual Buzz grant is `sendAward` below, and dedup is enforced
    // by the Redis Lua script in `processOnDemand` (which already committed the dedup
    // entry above). So a TRANSIENT ClickHouse transport failure (socket hang up /
    // Code 279 / Code 210) must NEVER 500 the user action: we log + count and skip
    // the award for this event. The user simply doesn't receive one reward credit
    // during a ClickHouse brownout — no 500, no double-award (the Redis dedup entry
    // is already set, so a retry of the same event returns early and never re-awards).
    // Use a SHORT retry budget so we don't block the mutation for ~2.5s during a
    // brownout. The batch `process` path is unchanged (background cron).
    //
    // NARROW the fail-soft to TRANSPORT errors only. A CH QUERY/SCHEMA error on the
    // `buzzEvents` insert — `Code: 60` UNKNOWN_TABLE (table dropped/renamed by a bad
    // deploy), `Code: 349` NULL→non-Nullable, a column-type break — is a REAL BUG,
    // not a brownout. Swallowing it would silently stop ALL buzz-event recording
    // with no 500 to flag it (exactly the failure mode that the recent missing-table
    // incident surfaced LOUDLY via 500s). So a non-transport error RETHROWS and
    // surfaces as a 500 → visible + alertable. (The mutation 500-ing on a genuine
    // schema break is the correct, loud behavior — it forces a fix.)
    try {
      await addBuzzEvent(event, INLINE_RETRY_COUNT, INLINE_RETRY_DELAY);
    } catch (error) {
      if (!isClickHouseConnectionError(error)) {
        // Real query/schema bug — surface it (500) so it can't hide.
        throw error;
      }
      log(event, { message: 'Failed to record Buzz event (CH transport)', error });
      rewardFailedCounter?.inc?.();
      clickhouseFailSoftCounter.inc({ path: 'buzz-reward' });
      // Fail-soft: do not rethrow. Skip sendAward for this event too — the audit row
      // that records the grant could not be written, so we treat the reward as not
      // granted this time rather than granting Buzz with no corresponding event row.
      return;
    }

    if (event.status === 'awarded') {
      try {
        await sendAward([event]);
        rewardGivenCounter?.inc?.();
      } catch (error) {
        log(event, {
          message: 'Failed to send award for Buzz event',
          error,
        });
        rewardFailedCounter?.inc?.();
        // Fail-soft: do not rethrow. No double-spend risk — `sendAward` is idempotent
        // on `externalTransactionId`, and the Redis dedup entry is already set so the
        // same event will never reach `sendAward` again. The user loses one reward
        // credit during the outage; the user's mutation still succeeds.
        return;
      }
    }
  };

  const process = async (ctx: ProcessingContext) => {
    if (!isProcessable || !clickhouse) return;

    const config = await resolveConfig();
    // `apply` only writes a `pending` row for a processable reward; this job is
    // what pays it. So gating `apply` alone still pays out everything already in
    // the pipe when the reward was turned off. Skipping those rows would strand
    // them, because the job scans `time >= lastUpdate` and never looks back —
    // hence a terminal `unqualified`, the state `process` already uses for
    // "seen, earns nothing".
    //
    // This lives in the reader rather than in a sweep hung off the config write:
    // the row is a `KeyValue` that gets edited from Retool or psql, where no
    // application code runs at all, and a per-run check also cannot lose the
    // race against rows written between the flip and the next run.
    if (!config.enabled) {
      for (const event of ctx.toProcess) {
        event.status = 'unqualified';
        event.awardAmount = 0;
      }
      await updateBuzzEvents(ctx.toProcess);
      return;
    }

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
      // `getMultipliersForUser` zeroes the multiplier for a rewards-ineligible user, and `apply`
      // stored that decision on the pending row. Leaving it `awarded` would both claim a payout
      // that did not happen and consume the user's cap, so a later eligible grant in the same
      // interval would be short by the amount never paid.
      //
      // `Number()` because the value is read back out of a ClickHouse `Decimal(3, 2)`: it arrives
      // unquoted today, but a client setting away from arriving as `'0.00'`, which `=== 0` misses.
      if (Number(event.multiplier) === 0) {
        event.status = 'unqualified';
        event.awardAmount = 0;
        continue;
      }

      // check against caps
      const prevAwardKeys = new Set<string>();
      if (buzzEvent.caps) {
        for (const { keyParts, interval, amount } of buzzEvent.caps) {
          // Get previously awarded
          const key = computeCapKey({ keyParts, interval, data: event });
          prevAwardKeys.add(key);
          const prevAward = prevAwards[key] ?? 0;

          // Determine amount remaining against cap
          const capAmount = capOverridable ? config.cap ?? amount : amount;
          const remaining = Math.max(capAmount - prevAward, 0);
          event.awardAmount = Math.min(event.awardAmount, remaining);
        }
      }

      // Handle award
      if (event.awardAmount > 0) {
        event.status = 'awarded';
        // Add the award to the prev awards for subsequent processing.
        // Use (prevAwards[keys] ?? 0) because keys with no prior 30-day awards
        // are absent from the ClickHouse-seeded map; bare `+=` produced NaN
        // which then poisoned every subsequent event's cap math.
        for (const keys of prevAwardKeys)
          prevAwards[keys] = (prevAwards[keys] ?? 0) + event.awardAmount;
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
              event.awardAmount = config.awardAmount;
            }
          }
          await updateBuzzEvents(chunk);
        }

        // Then throw the error
        throw new Error(
          `Buzz Event Processing Failure: Failed to ${transactionStatus} Buzz events for ${type}`,
          {
            cause: (error as any).message,
          }
        );
      }
    }
  };

  /**
   * The operator's answer to "which rewards are on, and at what amounts?".
   * Resolves through the same rules the grant path uses, so what it reports and
   * what gets paid cannot drift.
   *
   * 🔴 Takes the stored config rather than reading it, and the argument is
   * required on purpose. The grant path's `resolveConfig` memoises per pod for a
   * minute; an operator view that quietly picked that up would report a
   * minute-old answer on whichever pod served it, which is the state this
   * signature exists to make unrepresentable. Callers read the row themselves.
   */
  const describeConfig = async (config: RewardConfig) => {
    const resolved = resolveFromConfig(config, type, configDefaults);
    return {
      type,
      visible,
      onDemand: isOnDemand,
      capOverridable,
      defaults: { awardAmount, cap: defaultCap },
      effective: {
        enabled: resolved.enabled,
        awardAmount: resolved.awardAmount,
        cap: resolved.cap,
      },
      rejected: resolved.rejected,
    };
  };

  return {
    types,
    visible,
    apply,
    process,
    getUserRewardDetails,
    describeConfig,
  };
}

const INT32_MAX = 2147483647;
// `buzzEvents` is narrower than `BuzzEventLog`: `forId` is Int32, `status` is
// Enum8('pending','awarded','capped') and `multiplier` is Decimal(3, 2).
const CLICKHOUSE_STATUSES = new Set(['pending', 'awarded', 'capped']);
/**
 * Fit an event to the `buzzEvents` column types before it goes over the wire.
 *
 * Inserts run `async_insert=1, wait_for_async_insert=0`, so ClickHouse accepts the request, parses
 * the batch server-side afterwards, and drops it — the app sees success and `sendAward` still pays.
 * A value the column cannot hold therefore costs a row, or a whole 1000-row chunk, with no error
 * anywhere. Three fields could do it, and all three were doing it (ClickUp 868ktbnjh):
 *
 *   forId       a reward keyed on a string (generation-feedback's jobId, ad-watched's token,
 *               the removed appBlockReview's appBlockId). 4M payouts, zero event rows.
 *   status      `unqualified` is not in the enum, so a chunk carrying one loses the awarded and
 *               capped updates riding with it and those rows stay `pending` forever.
 *   multiplier  gold's 4 times MAX_GLOBAL_BONUS of 5 is 20, against a ceiling of 9.99.
 *
 * The original value is kept in `transactionDetails` so a coerced row is still traceable, and the
 * event itself is left alone so `sendAward`'s `externalTransactionId` keeps the value it has
 * always used.
 */
export function toClickhouseBuzzEvent(event: BuzzEventLog): BuzzEventLog {
  const coerced: MixedObject = {};

  let forId = event.forId;
  if (typeof forId === 'number') {
    // A number the column cannot hold is dropped exactly like a string would be, so the range
    // check belongs on both branches, not only on the parsed one.
    if (!Number.isInteger(forId) || Math.abs(forId) > INT32_MAX) {
      coerced.forIdRaw = forId;
      forId = hashify(String(forId));
    }
  } else {
    coerced.forIdRaw = forId;
    // Strict digits only: `Number('')` is 0 and `Number(' 42 ')` is 42, and buzzEvents is ordered
    // by (type, toUserId, forId, byUserId), so two keys collapsing to one id replace each other.
    forId =
      /^-?\d+$/.test(forId) && Math.abs(Number(forId)) <= INT32_MAX
        ? Number(forId)
        : hashify(forId);
  }

  let status = event.status;
  if (status && !CLICKHOUSE_STATUSES.has(status)) {
    coerced.statusRaw = status;
    // `unqualified` and `capped` both mean seen and paid nothing. Recording it as the nearest
    // legal value keeps the row; widening the enum would let it keep its own name.
    status = 'capped';
  }

  let multiplier = event.multiplier;
  if (multiplier !== undefined) {
    // Shared with the moderator's writer so the two apps cannot disagree about what the column
    // holds. That shared floor is also why an already-written row cannot arrive here with a
    // `multiplierRaw` this function would then overwrite in the merge below: `process` never
    // recomputes `multiplier`, so a row the other writer clamped comes back already in range.
    // `Number()` for the same reason as the `status === 0` read below: this value comes back out
    // of a ClickHouse `Decimal(3, 2)` on the process path, and `Number.isFinite` does not coerce
    // where the `>` test it replaced did. A quoted `'4.00'` would otherwise take the non-finite
    // fallback and rewrite a legitimate multiplier to 1 — an underpay, since `sendAward` pays
    // from it.
    const raw = Number(multiplier);
    const clamped = clampBuzzEventMultiplier(raw);
    if (clamped !== raw) {
      // `JSON.stringify` writes +/-Infinity and NaN as `null`, which reads as "the raw was absent"
      // — the one case that most needs a legible audit trail records the least. The moderator's
      // writer omits the key instead; it can, because it builds its row fresh. Here an omitted key
      // would leave `coerced` empty and return the unclamped event below.
      coerced.multiplierRaw = Number.isFinite(raw) ? raw : String(multiplier);
      multiplier = clamped;
      // On the batch path this value is not audit — `process-rewards` reads it back out and
      // `sendAward` pays `awardAmount * multiplier` from it, so a clamp UNDERPAYS rather than
      // rounding a record. Reported once per batch by the caller, not here: the condition becomes
      // reachable when a site-wide bonus event switches on, which clamps every gold member's pending
      // events at once, and this function runs per event per retry.
    }
  }

  if (Object.keys(coerced).length === 0) return event;

  let details: MixedObject;
  try {
    details = JSON.parse(event.transactionDetails ?? '{}');
  } catch {
    details = {};
  }

  return {
    ...event,
    forId,
    status,
    multiplier,
    transactionDetails: JSON.stringify({ ...details, ...coerced }),
  };
}

/** Fits a batch to the column types and reports a clamped multiplier once, with a count. */
function toClickhouseBuzzEvents(events: BuzzEventLog[]): BuzzEventLog[] {
  let clamped = 0;
  const rows = events.map((event) => {
    const row = toClickhouseBuzzEvent(event);
    if (row.multiplier !== event.multiplier) clamped++;
    return row;
  });

  if (clamped > 0) {
    logToAxiom({
      name: 'buzz-rewards',
      type: 'error',
      message: 'Buzz event multiplier fell outside the ClickHouse column range and was coerced',
      clampedEvents: clamped,
      batchSize: events.length,
      clampedTo: BUZZ_EVENTS_MAX_MULTIPLIER,
    }).catch(() => null);
  }

  return rows;
}

// TODO: sometimes this can cause duplicate entries.
//  hypothesis is that this occurs due to a combination of
//  async inserts + ch's merge strategy
async function addBuzzEvent(
  event: BuzzEventLog,
  retries: number = BATCH_RETRY_COUNT,
  retryTimeout: number = BATCH_RETRY_DELAY
) {
  await withRetries(
    async () =>
      await clickhouse?.insert({
        table: 'buzzEvents',
        values: toClickhouseBuzzEvents([event]),
        format: 'JSONEachRow',
      }),
    retries,
    retryTimeout
  );
}

async function updateBuzzEvents(events: BuzzEventLog[]) {
  for (const event of events) event.version = (event.version ?? 0) + 1;
  await withRetries(
    async () =>
      await clickhouse?.insert({
        table: 'buzzEvents',
        values: toClickhouseBuzzEvents(events),
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
  toAccountType?: BuzzSpendType;
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
