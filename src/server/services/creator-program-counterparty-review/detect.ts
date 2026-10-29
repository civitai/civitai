import { clickhouse } from '~/server/clickhouse/client';
import { OnboardingSteps } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import {
  clickhouseDateTime,
  platformPaidFromUsersSql,
  receivedFromUsersSql,
  SENT_TO_USER_SQL,
} from '~/server/services/creator-program-bankable';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';

/**
 * Creators and the users they exchange Buzz with in both directions.
 *
 * The bankable ledger already nets these exchanges (`creator-program-bankable.ts`), so this review
 * moves no money. It exists so a creator doing it at volume hears from us, and so a moderator can
 * decide whether they stay in the Creator Program.
 */

/** Stable producer key: it groups this review's runs on the abuse board. */
export const COUNTERPARTY_REVIEW_DETECTOR = 'creator-program-counterparty';

/** A ceiling on pairs read back, far above what the review files: members are filtered after it. */
export const PAIR_CEILING = 10_000;

/** Postgres parameter limits for the member lookup. */
const MEMBER_LOOKUP_CHUNK = 1_000;

export type CounterpartyPair = {
  userId: number;
  counterpartyId: number;
  /** Bankable Buzz the creator received from this user in the window. */
  received: number;
  /** Buzz the creator sent this user in the window. */
  sent: number;
};

export type Member = { id: number; username: string | null };

/** `$query` is the only method used, so a test substitutes this port rather than the client. */
export type ReviewClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

const earnedSince = (since: Date) =>
  `date >= ${clickhouseDateTime(
    since
  )} AND toAccountId > 0 AND toAccountType IN (${buzzBankTypesSql})`;

/** Buzz each user sent each other user in the window, per sender and payee. */
const sentBetweenUsersSql = (since: Date) => `
  SELECT sender, payee, sum(amount) AS amount FROM (
    SELECT toInt64(fromAccountId) AS sender, toInt64(toAccountId) AS payee,
      toInt64(amount) AS amount
    FROM buzzTransactions
    WHERE date >= ${clickhouseDateTime(since)} AND ${SENT_TO_USER_SQL}
    UNION ALL
    SELECT payer, recipient, amount FROM (${platformPaidFromUsersSql(earnedSince(since))})
  )
  GROUP BY sender, payee
`;

export function counterpartyPairsSql({ since, min }: { since: Date; min: number }) {
  return `
    SELECT received.recipient AS userId, received.payer AS counterpartyId,
      received.amount AS received, sent.amount AS sent
    FROM (${receivedFromUsersSql(earnedSince(since))}) AS received
    INNER JOIN (${sentBetweenUsersSql(since)}) AS sent
      ON sent.sender = received.recipient AND sent.payee = received.payer
    WHERE received.payer != received.recipient
      AND least(received.amount, sent.amount) >= ${Math.trunc(min)}
    ORDER BY least(received.amount, sent.amount) DESC
    LIMIT ${PAIR_CEILING}
  `;
}

export async function findCounterpartyPairs(
  ch: ReviewClickhouse,
  { since, min }: { since: Date; min: number }
): Promise<CounterpartyPair[]> {
  const rows = await ch.$query<{
    userId: string | number;
    counterpartyId: string | number;
    received: string | number;
    sent: string | number;
  }>(counterpartyPairsSql({ since, min }));

  return rows.map((r) => ({
    userId: Number(r.userId),
    counterpartyId: Number(r.counterpartyId),
    received: Number(r.received),
    sent: Number(r.sent),
  }));
}

/** How many other users Buzz passes through before it reaches the creator again. */
export const DEFAULT_MAX_INTERMEDIARIES = 2;
export const MAX_INTERMEDIARIES = 3;
/** Inside the job's lock, so a slow search fails on its own instead of overlapping the next run. */
const INDIRECT_QUERY_SECONDS = 120;

export type IndirectTransfer = {
  userId: number;
  /** The users it passed through, in order. */
  path: number[];
  /** The smallest leg: no more than this went all the way round. */
  amount: number;
};

/**
 * Buzz a creator sent that reached them again as bankable earnings through `intermediaries`
 * other users, every leg at least `min`. Each leg has its own column names and the distinct-user
 * check is a chain of `!=`: ClickHouse's old analyzer cannot resolve joined columns otherwise.
 */
export function indirectTransfersSql({
  since,
  min,
  intermediaries,
}: {
  since: Date;
  min: number;
  intermediaries: number;
}) {
  const floor = Math.max(1, Math.trunc(min));
  const hops = Math.min(MAX_INTERMEDIARIES, Math.max(2, Math.trunc(intermediaries) || 2));
  const legs = Array.from({ length: hops }, (_, i) => i + 1);
  const users = ['e1.s1', ...legs.map((i) => `e${i}.p${i}`)];
  const distinct = users.flatMap((a, i) => users.slice(0, i).map((b) => `${a} != ${b}`));
  const last = `e${hops}.p${hops}`;

  return `
    SELECT e1.s1 AS userId, [${legs.map((i) => `e${i}.p${i}`).join(', ')}] AS path,
      least(${[...legs.map((i) => `e${i}.amt${i}`), 'r.ramt'].join(', ')}) AS amount
    FROM ${legs
      .map(
        (i) => `(
      SELECT sender AS s${i}, payee AS p${i}, amount AS amt${i}
      FROM (${sentBetweenUsersSql(since)})
      WHERE amount >= ${floor}
    ) AS e${i}${i > 1 ? ` ON e${i}.s${i} = e${i - 1}.p${i - 1}` : ''}`
      )
      .join('\n    INNER JOIN ')}
    INNER JOIN (
      SELECT recipient AS rc, payer AS rp, amount AS ramt
      FROM (${receivedFromUsersSql(earnedSince(since))})
      WHERE amount >= ${floor}
    ) AS r ON r.rc = e1.s1 AND r.rp = ${last}
    WHERE ${distinct.join(' AND ')}
    ORDER BY amount DESC
    LIMIT ${PAIR_CEILING}
    SETTINGS max_execution_time = ${INDIRECT_QUERY_SECONDS}
  `;
}

export async function findIndirectTransfers(
  ch: ReviewClickhouse,
  params: { since: Date; min: number; intermediaries: number }
): Promise<IndirectTransfer[]> {
  const rows = await ch.$query<{
    userId: string | number;
    path: (string | number)[];
    amount: string | number;
  }>(indirectTransfersSql(params));

  return rows.map((r) => ({
    userId: Number(r.userId),
    path: r.path.map(Number),
    amount: Number(r.amount),
  }));
}

/** Current Creator Program members among `ids`: joined, not removed from the Program, not banned. */
export async function findProgramMembers(ids: number[]): Promise<Member[]> {
  const members: Member[] = [];
  for (let i = 0; i < ids.length; i += MEMBER_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + MEMBER_LOOKUP_CHUNK);
    members.push(
      ...(await dbRead.$queryRaw<Member[]>`
        SELECT id, username FROM "User"
        WHERE id = ANY(${chunk}::int[])
          AND onboarding & ${OnboardingSteps.CreatorProgram} != 0
          AND onboarding & ${OnboardingSteps.BannedCreatorProgram} = 0
          AND "bannedAt" IS NULL
          AND "deletedAt" IS NULL
      `)
    );
  }
  return members;
}

export const defaultClickhouse = (): ReviewClickhouse | null => clickhouse ?? null;
