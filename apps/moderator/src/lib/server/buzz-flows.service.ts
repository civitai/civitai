import { getClickhouse } from './clickhouse';
import { daysWindow } from './clickhouse-filters';
import { USER_ACCOUNT_TYPES_SQL } from './buzz-accounts';
import { isInt4Id, usersByIds } from './users.service';

// Where a set of accounts' Buzz came from and went.
//
// Account 0 is the platform: rewards, fees and generation charges move to or from it. Flows between
// two real accounts are listed; flows with the platform are summarised per account. Only user-held
// account types count as an account: a bank or cash account reuses user ids that are not its owner.

/** Lookback cap. `date` leads the sort key, so the window is what bounds the read. */
export const MAX_BUZZ_DAYS = 365;

export type AccountBuzz = {
  userId: number;
  username: string | null;
  /** Blue Buzz the platform paid this account (`reward` into the blue account). */
  blueRewarded: number;
  /** Buzz this account sent to other accounts, by the account type it was paid FROM. */
  sentToAccounts: Record<string, number>;
  receivedFromAccounts: Record<string, number>;
  trainings: number;
  /** Training charges paid from blue (reward) Buzz rather than bought Buzz. */
  trainingsOnBlue: number;
};

export type BuzzFlow = {
  from: number;
  to: number;
  type: string;
  fromAccountType: string;
  transactions: number;
  amount: number;
  /** Both ends are in the asked-about set. */
  withinSet: boolean;
  /** For purchases: the model versions bought, a sample. */
  modelVersionIds: number[];
};

export type BuzzFlows = {
  days: number;
  accounts: AccountBuzz[];
  flows: BuzzFlow[];
  truncated: boolean;
};

const FLOW_LIMIT = 200;

/**
 * `includeBank`: whether `bank` transactions are shown. User Lookup withholds them without the
 * `user.buzz.bank` grant, and this must not be a way round that.
 */
export async function getBuzzFlows(
  userIds: number[],
  days = 90,
  { includeBank = false } = {}
): Promise<BuzzFlows> {
  const ids = [...new Set(userIds)].filter(isInt4Id);
  const window = Math.min(MAX_BUZZ_DAYS, Math.max(1, Math.trunc(days)));
  if (!ids.length) return { days: window, accounts: [], flows: [], truncated: false };
  const set = ids.join(',');
  const since = `${daysWindow(window, { column: 'date' })}${
    includeBank ? '' : " AND type != 'bank'"
  }`;
  const user = (column: string) => `${column} IN (${USER_ACCOUNT_TYPES_SQL})`;

  const ch = getClickhouse();
  const [summary, flows, byId] = await Promise.all([
    ch.$query<{
      uid: string;
      blueRewarded: string;
      sent: [string[], string[]];
      received: [string[], string[]];
      trainings: string;
      trainingsOnBlue: string;
    }>(`
      SELECT uid,
             sumIf(amount, dir = 'in' AND type = 'reward' AND toAccountType = 'blue' AND other = 0) AS blueRewarded,
             sumMapIf([fromAccountType], [toInt64(amount)], dir = 'out' AND other > 0 AND ${user(
               'toAccountType'
             )}) AS sent,
             sumMapIf([fromAccountType], [toInt64(amount)], dir = 'in' AND other > 0 AND ${user(
               'fromAccountType'
             )}) AS received,
             countIf(dir = 'out' AND type = 'training') AS trainings,
             countIf(dir = 'out' AND type = 'training' AND fromAccountType = 'blue') AS trainingsOnBlue
      FROM (
        SELECT toAccountId AS uid, 'in' AS dir, fromAccountId AS other, type, amount, fromAccountType, toAccountType
        FROM default.buzzTransactions PREWHERE toAccountId IN (${set})
        WHERE ${since} AND ${user('toAccountType')}
        UNION ALL
        SELECT fromAccountId AS uid, 'out' AS dir, toAccountId AS other, type, amount, fromAccountType, toAccountType
        FROM default.buzzTransactions PREWHERE fromAccountId IN (${set})
        WHERE ${since} AND ${user('fromAccountType')}
      )
      GROUP BY uid
    `),
    ch.$query<{
      from: string;
      to: string;
      type: string;
      fromAccountType: string;
      transactions: string;
      amount: string;
      versions: string[];
    }>(`
      SELECT fromAccountId AS from, toAccountId AS to, type, fromAccountType,
             count() AS transactions, sum(amount) AS amount,
             groupUniqArray(10)(JSONExtractString(details, 'modelVersionId')) AS versions
      FROM default.buzzTransactions
      PREWHERE fromAccountId IN (${set}) OR toAccountId IN (${set})
      WHERE ${since} AND fromAccountId > 0 AND toAccountId > 0 AND fromAccountId != toAccountId
        AND ${user('fromAccountType')} AND ${user('toAccountType')}
      GROUP BY from, to, type, fromAccountType
      ORDER BY (fromAccountId IN (${set}) AND toAccountId IN (${set})) DESC, amount DESC
      LIMIT ${FLOW_LIMIT + 1}
    `),
    usersByIds(ids),
  ]);

  const listed = flows.slice(0, FLOW_LIMIT).map((f) => ({
    from: Number(f.from),
    to: Number(f.to),
    type: f.type,
    fromAccountType: f.fromAccountType,
    transactions: Number(f.transactions),
    amount: Number(f.amount),
    withinSet: ids.includes(Number(f.from)) && ids.includes(Number(f.to)),
    modelVersionIds: f.versions.map(Number).filter((v) => v > 0),
  }));

  const sums = new Map(summary.map((s) => [Number(s.uid), s]));
  const accounts = ids.map((userId) => {
    const s = sums.get(userId);
    return {
      userId,
      username: byId.get(userId)?.username ?? null,
      blueRewarded: Number(s?.blueRewarded ?? 0),
      sentToAccounts: byAccountType(s?.sent),
      receivedFromAccounts: byAccountType(s?.received),
      trainings: Number(s?.trainings ?? 0),
      trainingsOnBlue: Number(s?.trainingsOnBlue ?? 0),
    };
  });

  return { days: window, accounts, flows: listed, truncated: flows.length > FLOW_LIMIT };
}

const byAccountType = (map: [string[], string[]] | undefined): Record<string, number> =>
  Object.fromEntries((map?.[0] ?? []).map((type, i) => [type, Number(map?.[1][i] ?? 0)]));
