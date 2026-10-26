import { dbRead } from '~/server/db/client';
import { getUserBuzzTransactionsResponse } from '~/server/schema/buzz.schema';
import { buzzService } from '~/server/services/buzz.service';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import dayjs from '~/shared/utils/dayjs';

// Where a hand grant for a deposit can land, and the types it is made as. Goodwill grants are made
// as Rewards to yellow or blue. Compensation is left out: automated, and numerous enough on a
// creator's account to exhaust the scan.
const HAND_GRANT_TYPES = [TransactionType.Tip, TransactionType.Incentive, TransactionType.Refund];
const SCANS: [BuzzAccountType, TransactionType[]][] = [
  ['yellow', [...HAND_GRANT_TYPES, TransactionType.Reward]],
  ['blue', [...HAND_GRANT_TYPES, TransactionType.Reward]],
  ['green', HAND_GRANT_TYPES],
  ['cashPending', HAND_GRANT_TYPES],
  ['cashSettled', HAND_GRANT_TYPES],
];
const SCAN_PAGE_SIZE = 200;
// A scan that cannot finish refuses: an unread page could hold the grant.
const SCAN_MAX_PAGES = 20;

export type ManualCredit = {
  /** What `acknowledge` names: the ledger key, or date|sender|amount when the row has none. */
  ref: string;
  date: string;
  type: string;
  amount: number;
  accountType: string;
  fromAccountId: number;
  description: string | null;
  externalTransactionId: string | null;
};

export type ManualCreditMatch = ManualCredit & {
  strength: 'hard' | 'soft';
  why: string;
  fromStaff: boolean;
};

const containsPaymentId = (text: string, paymentId: number) =>
  new RegExp(`(?<!\\d)${paymentId}(?!\\d)`).test(text);

/** Support cites a payin hash by its first few characters ("tx 0xbf7255…"), so any 6+ hex prefix counts. */
const containsPayinHashPrefix = (text: string, payinHash: string) => {
  const hash = payinHash.toLowerCase().replace(/^0x/, '');
  for (const [, run] of text.toLowerCase().matchAll(/(?:0x)?([0-9a-f]{6,})/g))
    if (hash.startsWith(run)) return true;
  return false;
};

const DEPOSIT_KEYWORDS =
  /\b(?:crypto|deposit|nowpayments|payin|usdt|payment|disbursement)|\b(?:np|btc|eth|tx)\b/i;
const SOFT_AMOUNT_TOLERANCE = 0.5;

/**
 * Whether a credit to the depositing user may already cover this payment. Hard matches cite the
 * payment and cannot be overridden; soft matches look like a hand grant for a deposit and can be,
 * by a moderator naming them in `acknowledge`.
 *
 * The soft tolerance is wide because hand grants are valued at payment time and NowPayments
 * settles later, so a hand grant for this payment rarely matches the settled amount.
 */
export function matchManualCredit(
  credit: ManualCredit,
  ctx: { paymentId: number; payinHash: string | null; expectedBuzz: number; fromStaff: boolean }
): Pick<ManualCreditMatch, 'strength' | 'why'> | null {
  const text = [credit.description, credit.externalTransactionId].filter(Boolean).join(' ');
  if (containsPaymentId(text, ctx.paymentId))
    return { strength: 'hard', why: 'cites the payment id' };
  if (ctx.payinHash && containsPayinHashPrefix(text, ctx.payinHash))
    return { strength: 'hard', why: 'cites the payin hash' };

  if (!ctx.fromStaff) return null;
  if (credit.description && DEPOSIT_KEYWORDS.test(credit.description))
    return { strength: 'soft', why: 'staff grant mentioning a deposit' };
  // Rewards and Refunds from the bank are mostly automated (ad impressions, generation refunds), so
  // their amount says nothing; only Tips and Incentives are matched on it.
  const amountCounts = credit.type === 'Tip' || credit.type === 'Incentive';
  if (
    amountCounts &&
    Math.abs(credit.amount - ctx.expectedBuzz) <= ctx.expectedBuzz * SOFT_AMOUNT_TOLERANCE
  )
    return { strength: 'soft', why: 'staff grant near the deposit amount' };
  return null;
}

/** Every credit of a scanned type into the user's accounts since `start`, read live from the Buzz service. */
async function getCreditsSince(userId: number, start: Date) {
  const pairs = SCANS.flatMap(([accountType, types]) =>
    types.map((type) => ({ accountType, type }))
  );
  // Read the pairs together: the deposit webhook waits on this scan.
  const perPair = await Promise.all(
    pairs.map(async ({ accountType, type }) => {
      const credits: ManualCredit[] = [];
      let cursor: Date | undefined;
      for (let page = 0; ; page++) {
        if (page === SCAN_MAX_PAGES)
          throw new Error(`Too many ${TransactionType[type]} transactions to scan`);
        const data = await buzzService.getAccountTransactions(userId, {
          accountType,
          query: { type, start, cursor, limit: SCAN_PAGE_SIZE, descending: true },
        });
        const parsed = getUserBuzzTransactionsResponse.parse(data);
        for (const t of parsed.transactions) {
          if (t.toAccountId !== userId || t.fromAccountId === userId) continue;
          const externalTransactionId = t.externalTransactionId ?? null;
          credits.push({
            ref: externalTransactionId ?? `${t.date.toISOString()}|${t.fromAccountId}|${t.amount}`,
            date: t.date.toISOString(),
            type: TransactionType[t.type],
            amount: t.amount,
            accountType,
            fromAccountId: t.fromAccountId,
            description: t.description ?? null,
            externalTransactionId,
          });
        }
        if (!parsed.cursor || parsed.transactions.length === 0) break;
        cursor = parsed.cursor;
      }
      return credits;
    })
  );
  return perPair.flat();
}

export async function findManualCredits(
  userId: number,
  ctx: { paymentId: number; payinHash: string | null; expectedBuzz: number; since: Date }
) {
  const credits = await getCreditsSince(userId, ctx.since);
  const senderIds = [...new Set(credits.map((c) => c.fromAccountId).filter((id) => id !== 0))];
  const moderators = senderIds.length
    ? await dbRead.user.findMany({
        where: { id: { in: senderIds }, isModerator: true },
        select: { id: true },
      })
    : [];
  const staff = new Set([0, ...moderators.map((m) => m.id)]);

  const matches: ManualCreditMatch[] = [];
  for (const credit of credits) {
    const fromStaff = staff.has(credit.fromAccountId);
    // A creator's Rewards are mostly from other users' actions; only a staff Reward can be a hand grant.
    if (credit.type === 'Reward' && !fromStaff) continue;
    const match = matchManualCredit(credit, { ...ctx, fromStaff });
    if (match) matches.push({ ...credit, ...match, fromStaff });
  }
  return matches;
}

const SCAN_FALLBACK_DAYS = 7;

/**
 * The hand grants that stop an automatic credit of this deposit, and the ones only worth flagging.
 * Only staff grants hold a deposit: anyone can tip a description citing a public payin hash.
 */
export async function findHandGrantsForDeposit(
  userId: number,
  ctx: {
    paymentId: number;
    payinHash: string | null;
    expectedBuzz: number;
    paymentCreatedAt: Date | null | undefined;
  }
) {
  // Support grants only after the user reports the payment; the day of margin covers clock skew.
  const since = dayjs
    .utc(ctx.paymentCreatedAt ?? dayjs.utc().subtract(SCAN_FALLBACK_DAYS, 'day'))
    .subtract(1, 'day')
    .toDate();
  const matches = await findManualCredits(userId, { ...ctx, since });
  const covering = matches.filter((m) => m.strength === 'hard' && m.fromStaff);
  return { covering, possible: covering.length ? [] : matches };
}
