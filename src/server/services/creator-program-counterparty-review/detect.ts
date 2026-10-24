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

export function counterpartyPairsSql({ since, min }: { since: Date; min: number }) {
  return `
    SELECT received.recipient AS userId, received.payer AS counterpartyId,
      received.amount AS received, sent.amount AS sent
    FROM (${receivedFromUsersSql(earnedSince(since))}) AS received
    INNER JOIN (
      SELECT sender, payee, sum(amount) AS amount FROM (
        SELECT toInt64(fromAccountId) AS sender, toInt64(toAccountId) AS payee,
          toInt64(amount) AS amount
        FROM buzzTransactions
        WHERE date >= ${clickhouseDateTime(since)} AND ${SENT_TO_USER_SQL}
        UNION ALL
        SELECT payer, recipient, amount FROM (${platformPaidFromUsersSql(earnedSince(since))})
      )
      GROUP BY sender, payee
    ) AS sent ON sent.sender = received.recipient AND sent.payee = received.payer
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
