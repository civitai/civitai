import {
  BANKABLE_EARNING_PREDICATE_SQL,
  RECEIVED_FROM_USER_SQL,
  SENT_TO_USER_SQL,
} from '~/server/services/creator-program-bankable';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';
import dayjs from '~/shared/utils/dayjs';
import type { Counterparty } from './signals';

export type ReviewClickhouse = { $query: <T extends object>(sql: string) => Promise<T[]> };

export function periodWindow(period: string, historyPeriods = 0) {
  const start = dayjs.utc(`${period}-01`);
  return {
    start: start.toDate(),
    end: start.add(1, 'month').toDate(),
    priorPeriods: Array.from({ length: historyPeriods }, (_, i) =>
      start.subtract(i + 1, 'month').format('YYYY-MM')
    ),
  };
}

const chDate = (at: Date) => `'${at.toISOString().slice(0, 19).replace('T', ' ')}'`;
const poolCreditPrefix = (period: string) => `comp-pool-unified-${period}-`;
const assertPeriod = (period: string) => {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`Invalid period ${period}`);
};

/** The distribute job's credits as booked, not a recomputation of the pool. */
export async function loadBatch(ch: ReviewClickhouse, period: string) {
  assertPeriod(period);
  const { start } = periodWindow(period);
  const rows = await ch.$query<{ userId: string | number; payoutCents: string | number }>(`
    SELECT toAccountId AS userId, sum(amount) AS payoutCents
    FROM buzzTransactions
    WHERE toAccountType = 'cashPending' AND date >= ${chDate(start)}
      AND startsWith(externalTransactionId, '${poolCreditPrefix(period)}')
    GROUP BY userId
  `);
  return rows.map((r) => ({ userId: Number(r.userId), payoutCents: Number(r.payoutCents) }));
}

export async function loadPriorPayouts(
  ch: ReviewClickhouse,
  userIds: number[],
  period: string,
  historyPeriods: number
) {
  const { priorPeriods } = periodWindow(period, historyPeriods);
  const byUser = new Map<number, number[]>();
  if (!userIds.length || !priorPeriods.length) return byUser;
  const rows = await ch.$query<{ userId: string | number; period: string; payoutCents: string }>(`
    SELECT toAccountId AS userId, substring(externalTransactionId, ${
      poolCreditPrefix('').length + 1
    }, 7) AS period,
      sum(amount) AS payoutCents
    FROM buzzTransactions
    WHERE toAccountType = 'cashPending' AND toAccountId IN (${userIds.join(',')})
      AND date >= ${chDate(dayjs.utc(`${priorPeriods[priorPeriods.length - 1]}-01`).toDate())}
      AND (${priorPeriods
        .map((p) => `startsWith(externalTransactionId, '${poolCreditPrefix(p)}')`)
        .join(' OR ')})
    GROUP BY userId, period
  `);
  for (const r of rows) {
    const list = byUser.get(Number(r.userId)) ?? [];
    list[priorPeriods.indexOf(r.period)] = Number(r.payoutCents);
    byUser.set(Number(r.userId), list);
  }
  for (const [userId, list] of byUser)
    byUser.set(
      userId,
      list.filter((v) => v !== undefined)
    );
  return byUser;
}

export async function loadEarnings(ch: ReviewClickhouse, userIds: number[], period: string) {
  const { start, end } = periodWindow(period);
  const bankable = new Map<number, number>();
  const counterparties = new Map<number, Counterparty[]>();
  if (!userIds.length) return { bankable, counterparties };
  const ids = userIds.join(',');
  const window = `date >= ${chDate(start)} AND date < ${chDate(end)}`;

  const [totals, pairs] = await Promise.all([
    ch.$query<{ userId: string | number; amount: string | number }>(`
      SELECT toAccountId AS userId, sum(amount) AS amount
      FROM buzzTransactions
      WHERE ${window} AND toAccountId IN (${ids}) AND toAccountType IN (${buzzBankTypesSql})
        AND ${BANKABLE_EARNING_PREDICATE_SQL}
      GROUP BY userId
    `),
    ch.$query<{
      userId: string | number;
      payerId: string | number;
      received: string | number;
      sent: string | number;
    }>(`
      SELECT r.userId AS userId, r.payerId AS payerId, r.amount AS received,
        coalesce(s.amount, 0) AS sent
      FROM (
        SELECT toAccountId AS userId, fromAccountId AS payerId, sum(amount) AS amount
        FROM buzzTransactions
        WHERE ${window} AND toAccountId IN (${ids}) AND toAccountType IN (${buzzBankTypesSql})
          AND ${BANKABLE_EARNING_PREDICATE_SQL} AND ${RECEIVED_FROM_USER_SQL}
          AND fromAccountId != toAccountId
        GROUP BY userId, payerId
      ) AS r
      LEFT JOIN (
        SELECT fromAccountId AS userId, toAccountId AS payerId, sum(amount) AS amount
        FROM buzzTransactions
        WHERE ${window} AND fromAccountId IN (${ids}) AND ${SENT_TO_USER_SQL}
        GROUP BY userId, payerId
      ) AS s ON s.userId = r.userId AND s.payerId = r.payerId
    `),
  ]);

  for (const t of totals) bankable.set(Number(t.userId), Number(t.amount));
  for (const p of pairs) {
    const list = counterparties.get(Number(p.userId)) ?? [];
    list.push({ userId: Number(p.payerId), received: Number(p.received), sent: Number(p.sent) });
    counterparties.set(Number(p.userId), list);
  }
  return { bankable, counterparties };
}
