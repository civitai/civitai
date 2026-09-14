import { clickhouse } from '~/server/clickhouse/client';
import { dbRead } from '~/server/db/client';

/**
 * Accounts that give a reaction and take it back within seconds, at volume.
 *
 * 🔴 WHY THIS IS INVISIBLE EVERYWHERE ELSE. Removing a reaction deletes the `ImageReaction` row, so
 * Postgres — which every moderator surface reads — holds no trace of a withdrawn reaction. The pair
 * of events survives only in ClickHouse. That is not a reporting gap to be patched on the image page:
 * an account doing this leaves nothing on any single image for a moderator to notice, which is why
 * this has to be a detector over the whole population rather than a panel.
 *
 * Measured 2026-09-09 over one week of `default.reactions`, against bans moderators had already
 * issued with no knowledge of this signal:
 *
 *   selected by this rule                   9,159 accounts — 8,427 banned (92.0%)
 *   ├─ created < 90 days ago                8,518 accounts — 8,426 banned (98.9%)
 *   └─ older                                  641 accounts —     1 banned (0.16%)
 *   control: >=10 reactions, 0 withdrawals 12,000 accounts —     9 banned (0.075%)
 *
 * 🔴 THE AGE FILTER IS NOT A TUNING KNOB, IT IS HALF THE RULE. Established accounts doing the
 * identical thing are effectively never banned — 1 of 641 — so moderators have consistently
 * judged the behaviour not-abuse on an old account. Including them would put ~640 rows a week in
 * front of a human with a measured 0.16% hit rate. (Worth someone's time separately: an established
 * account emitting create+delete pairs at all suggests a double-toggle in the reaction UI. That is a
 * main-app bug, not a moderation matter, and it is deliberately out of scope here.)
 */

/** The producer key. Opaque — it groups runs on the board, so renaming it orphans this detector's
 *  history. */
export const REACTION_WITHDRAWAL_DETECTOR = 'reaction-withdrawal';

/**
 * A withdrawal this fast is not a person changing their mind.
 *
 * Measured on the case this was built from: 784 of 817 withdrawals landed inside 60s and the median
 * gap was 0s, against 15-29 HOURS median on three ordinary images of comparable size. The threshold
 * sits in the empty space between those two populations, so moving it a little either way changes
 * almost nothing — which is the property that makes it safe to state as a constant.
 */
const INSTANT_SECONDS = 60;

/** Below this the pattern is indistinguishable from a few mis-taps. */
const MIN_CYCLES = 10;

/** Older than this, the behaviour has a measured 0.16% concordance with moderator judgement. */
const MAX_ACCOUNT_AGE_DAYS = 90;

const WINDOW_DAYS = 7;

/**
 * 🔴 A CEILING, NOT A PAGE — AND IT MUST STAY FAR ABOVE THE NUMBER OF ROWS THAT REACH THE BOARD.
 *
 * The ban and age filters live in Postgres, so they run AFTER this. Ordered by volume, the head of
 * this list is the accounts that have been doing it longest — which is to say the ones moderators
 * have already banned. Measured 2026-09-09: the top 1,000 by cycle count contained **9 of the 98
 * live accounts then measured**, so a 1,000-row cap here would have hidden most of the queue while reporting a
 * comfortable-looking 1,000 candidates scanned.
 *
 * Same defect as capping a ranked list before scoring it. The right cap is the one on `findings`,
 * which the contract already enforces at 1,000, applied to rows that have survived every filter.
 */
const CANDIDATE_CEILING = 50_000;

/** Postgres parameter limits, not a tuning choice: the candidate set runs to five figures and one
 *  `IN` list that long is refused. */
const ACCOUNT_LOOKUP_CHUNK = 1_000;

export type WithdrawalCandidate = {
  userId: number;
  /** Reactions given and taken back inside `INSTANT_SECONDS`. */
  cycles: number;
  /** Every reaction the account gave in the window, withdrawn or not — the denominator a moderator
   *  needs to tell "automated" from "clumsy". */
  given: number;
  /** Distinct creators they reacted to. High here is what separates this from a targeted ring. */
  creators: number;
};

export type WithdrawalAccount = WithdrawalCandidate & {
  username: string | null;
  createdAt: Date;
  ageDays: number;
  /** Email verified within two minutes of signup — a human opening a mail client does not do that.
   *  Null when either timestamp is missing, which is not the same as false. */
  instantVerify: boolean | null;
};

/** `$query` is the only method used, so the port is stated rather than importing the whole client
 *  type — and it is what a test substitutes. */
export type DetectionClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

/**
 * 🔴 ONE PASS, GROUPED BY (user, image). The pairing has to happen in ClickHouse: the alternative is
 * reading a week of raw reaction events into node to match them up, and that week is ~6.9M rows.
 *
 * 🔴 `secs >= 0` IS A CORRECTNESS GUARD, NOT TIDYING. `dateDiff` on `min(create)`/`max(delete)` goes
 * NEGATIVE at the window edge: a reaction given BEFORE the window and withdrawn inside it has a delete
 * with no create to pair against, so the arithmetic runs backwards. A bare `secs <= 60` counts every
 * one of those as an instant withdrawal — which is the opposite of what they are, since a reaction
 * held for weeks and then removed is an ordinary change of mind. Measured over one week: 162,496 of
 * the 725,440 rows a bare `<= 60` selects were negative, so it over-counted by 22%.
 */
export async function findWithdrawalCandidates(
  ch: DetectionClickhouse,
  { windowDays = WINDOW_DAYS, minCycles = MIN_CYCLES, limit = CANDIDATE_CEILING } = {}
): Promise<WithdrawalCandidate[]> {
  const rows = await ch.$query<{
    userId: string | number;
    cycles: string | number;
    given: string | number;
    creators: string | number;
  }>(`
    SELECT userId, count() AS cycles, any(given) AS given, any(creators) AS creators
    FROM (
      SELECT userId,
             entityId,
             dateDiff('second', minIf(time, type = 'Image_Create'), maxIf(time, type = 'Image_Delete')) AS secs
      FROM default.reactions
      WHERE time >= now() - INTERVAL ${Math.trunc(windowDays)} DAY
        AND type IN ('Image_Create', 'Image_Delete')
        AND userId != 0
      GROUP BY userId, entityId
      HAVING countIf(type = 'Image_Create') > 0
         AND countIf(type = 'Image_Delete') > 0
         AND secs >= 0
         AND secs <= ${INSTANT_SECONDS}
    ) AS cycle
    ANY LEFT JOIN (
      SELECT userId, count() AS given, uniq(ownerId) AS creators
      FROM default.reactions
      WHERE time >= now() - INTERVAL ${Math.trunc(windowDays)} DAY
        AND type = 'Image_Create'
        AND userId != 0
      GROUP BY userId
    ) AS totals USING (userId)
    GROUP BY userId
    HAVING cycles >= ${Math.trunc(minCycles)}
    ORDER BY cycles DESC
    LIMIT ${Math.trunc(limit)}
  `);

  return rows.map((r) => ({
    userId: Number(r.userId),
    cycles: Number(r.cycles),
    given: Number(r.given),
    creators: Number(r.creators),
  }));
}

/**
 * The age filter and the account facts.
 *
 * Already-banned and deleted accounts are dropped HERE rather than reported with `actioned: false`.
 * The board is a queue for a human, and 8,429 of the 8,546 accounts this rule selects are already
 * banned — reporting them would bury the ~77 live ones under a week of work someone already did.
 */
export async function describeAccounts(
  candidates: WithdrawalCandidate[],
  { maxAgeDays = MAX_ACCOUNT_AGE_DAYS, now = new Date() } = {}
): Promise<WithdrawalAccount[]> {
  if (!candidates.length) return [];
  const byId = new Map(candidates.map((c) => [c.userId, c]));
  const ids = [...byId.keys()];
  const createdAfter = new Date(now.getTime() - maxAgeDays * 86_400_000);

  const rows: {
    id: number;
    username: string | null;
    createdAt: Date;
    emailVerified: Date | null;
  }[] = [];
  for (let i = 0; i < ids.length; i += ACCOUNT_LOOKUP_CHUNK) {
    rows.push(
      ...(await dbRead.user.findMany({
        where: {
          id: { in: ids.slice(i, i + ACCOUNT_LOOKUP_CHUNK) },
          bannedAt: null,
          deletedAt: null,
          createdAt: { gte: createdAfter },
        },
        select: { id: true, username: true, createdAt: true, emailVerified: true },
      }))
    );
  }

  return rows.flatMap((u) => {
    const candidate = byId.get(u.id);
    if (!candidate) return [];
    return [
      {
        ...candidate,
        username: u.username,
        createdAt: u.createdAt,
        ageDays: Math.floor((now.getTime() - u.createdAt.getTime()) / 86_400_000),
        instantVerify: u.emailVerified
          ? u.emailVerified.getTime() - u.createdAt.getTime() < 120_000
          : null,
      },
    ];
  });
}

export const detectionConfig = {
  INSTANT_SECONDS,
  MIN_CYCLES,
  MAX_ACCOUNT_AGE_DAYS,
  WINDOW_DAYS,
  CANDIDATE_CEILING,
  ACCOUNT_LOOKUP_CHUNK,
};

export const defaultClickhouse = (): DetectionClickhouse | null => clickhouse ?? null;
