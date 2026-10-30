import { dbRead } from './db';
import { getClickhouse } from './clickhouse';
import { clickhouseDate } from './clickhouse-date';
import { COMMENT_SPAM } from '$lib/comment-spam';

export type CommentSpamAccount = {
  userId: number;
  username: string | null;
  email: string | null;
  createdAt: Date;
  comments: number;
  /** Start of the hour the burst happened in. */
  hour: Date;
  /** Hours between signup and the burst. The wave's median was 1.1. */
  ageAtBurstHours: number;
};

export type BurstRow = { userId: number; comments: number; hour: Date };
export type AccountRow = {
  id: number;
  username: string | null;
  email: string | null;
  createdAt: Date;
  bannedAt: Date | null;
  deletedAt: Date | null;
};

/**
 * Which bursts belong in the queue, given the accounts behind them.
 *
 * Pure, because this is the half worth testing: everything the rule rejects, it rejects here. A burst
 * from an account that was already a week old is a moderator or a popular creator answering their
 * comments, not a script.
 */
export function selectSpamCandidates(bursts: BurstRow[], accounts: AccountRow[]) {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return bursts
    .flatMap((burst) => {
      const account = byId.get(burst.userId);
      // Already actioned, or gone. The queue is a list of things to do.
      if (!account || account.bannedAt || account.deletedAt) return [];
      const ageAtBurstHours = (burst.hour.getTime() - account.createdAt.getTime()) / 3_600_000;
      if (ageAtBurstHours > COMMENT_SPAM.maxAccountAgeDays * 24) return [];
      return [
        {
          userId: burst.userId,
          username: account.username,
          email: account.email,
          createdAt: account.createdAt,
          comments: burst.comments,
          hour: burst.hour,
          // A burst timestamped before signup is a clock skew between the two systems, not a negative
          // age; floor it so the column never reads as nonsense.
          ageAtBurstHours: Math.max(0, ageAtBurstHours),
        },
      ];
    })
    .sort((a, b) => b.hour.getTime() - a.hour.getTime());
}

/**
 * Accounts whose comments match the spam signature, newest burst first.
 *
 * ClickHouse holds the events; Postgres holds who the account is and whether anyone has dealt with it
 * already. It has to be this way round — moderators delete the comments when they ban, so Postgres
 * cannot answer "who did this" for anyone actioned, which is most of a wave.
 */
export async function getCommentSpamAccounts({ days = 7, limit = 200 } = {}): Promise<{
  accounts: CommentSpamAccount[];
  /** The ClickHouse read hit its cap — and it caps BEFORE the exclusions below, so the rendered count
   *  is neither the number of matches nor the cap. The page has to say so rather than imply a total. */
  truncated: boolean;
}> {
  const rows = await getClickhouse().$query<{
    userId: string;
    comments: string;
    hour: string;
  }>(`
    SELECT userId, count() AS comments, toString(toStartOfHour(time)) AS hour
    FROM comments
    WHERE time >= now() - INTERVAL ${Number(days)} DAY AND userId > 0
    GROUP BY userId, toStartOfHour(time)
    HAVING comments >= ${COMMENT_SPAM.minComments}
    -- No LIMIT. The cap has to come AFTER the already-banned rows are dropped: during a wave the
    -- newest hours are almost entirely accounts a moderator has just banned, so a capped read returns
    -- 200 rows that all get excluded and the page says "nothing matches" mid-wave. Measured
    -- 2026-08-24: 1,000 qualifying bursts in 7 days, of which 61 accounts were unactioned.
    ORDER BY hour DESC
  `);
  if (!rows.length) return { accounts: [], truncated: false };

  const bursts: BurstRow[] = rows.map((r) => ({
    userId: Number(r.userId),
    comments: Number(r.comments),
    hour: new Date(clickhouseDate(r.hour)),
  }));

  const accounts = (await dbRead
    .selectFrom('User')
    .select(['id', 'username', 'email', 'createdAt', 'bannedAt', 'deletedAt'])
    .where(
      'id',
      'in',
      bursts.map((b) => b.userId)
    )
    .execute()) as AccountRow[];

  const candidates = selectSpamCandidates(bursts, accounts);
  return { accounts: candidates.slice(0, limit), truncated: candidates.length > limit };
}

export const COMMENT_SPAM_WINDOWS = [1, 7, 30] as const;
export type CommentSpamWindow = (typeof COMMENT_SPAM_WINDOWS)[number];
export { COMMENT_SPAM };
