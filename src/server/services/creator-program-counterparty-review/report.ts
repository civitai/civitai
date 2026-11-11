import { MAX_REASON_LENGTH, type AbuseReportInput } from '@civitai/moderation';
import { NO_ACTION_TAKEN, plural } from '../abuse-report-prose';
import type { CounterpartyPair, IndirectTransfer } from './detect';

type Finding = AbuseReportInput['findings'][number];

export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`;
}

const twoWay = (p: CounterpartyPair) => Math.min(p.received, p.sent);

function describePairs(pairs: CounterpartyPair[]) {
  return pairs
    .map(
      (p) =>
        `with account ${
          p.counterpartyId
        }: received ${p.received.toLocaleString()} Buzz, sent back ${p.sent.toLocaleString()}`
    )
    .join('; ');
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The amounts the review compared go in the reason, so a moderator can check the finding without
 * trusting a score. The window is stated once: everything is since the bankable cutover.
 * `firstFiledAt` is set when the creator was filed before and the exchange grew again.
 */
export function renderReason(
  pairs: CounterpartyPair[],
  firstFiledAt: Date | null,
  since: Date,
  indirect: IndirectTransfer[] = []
): string {
  const total = pairs.reduce((sum, p) => sum + twoWay(p), 0);
  const window = `since ${day(since)}`;
  const head =
    `Exchanged Buzz in both directions with ${pairs.length} ${plural(
      pairs.length,
      'account'
    )} ${window} ` +
    `(${describePairs(
      pairs
    )}). ${total.toLocaleString()} Buzz went both ways and was left out of their bankable earnings.`;
  const earlier = firstFiledAt
    ? ` First filed on ${day(firstFiledAt)}, and the exchange grew again after that.`
    : '';
  // Last, so a long list is what gets cut rather than what the review did.
  const tail = indirect.length ? ` ${describeIndirect(indirect, since)}` : '';
  return truncateReason(
    `${head}${earlier} Removing the account from the Creator Program is a moderator decision. ${NO_ACTION_TAKEN}${tail}`
  );
}

/** Repeats sort above first filings: they are the rows that need a moderator. */
export function toFinding(
  userId: number,
  pairs: CounterpartyPair[],
  firstFiledAt: Date | null,
  since: Date,
  indirect: IndirectTransfer[] = []
): Finding {
  return {
    userId,
    confidence: firstFiledAt ? 0.95 : 0.9,
    reason: renderReason(pairs, firstFiledAt, since, indirect),
    actioned: false,
  };
}

/** Below a direct exchange: more innocent patterns look like this, so a moderator decides. */
export const INDIRECT_CONFIDENCE = 0.7;

/** Enough for a moderator to start from; the rest are counted, not listed. */
const INDIRECT_PATHS_SHOWN = 5;

/** The members of a transfer's loop, so a moderator can see which findings are one loop. */
export const loopKey = (t: IndirectTransfer) =>
  [t.userId, ...t.path].sort((a, b) => a - b).join('-');

function describeIndirect(transfers: IndirectTransfer[], since: Date) {
  const shown = transfers
    .slice(0, INDIRECT_PATHS_SHOWN)
    .map(
      (t) =>
        `through accounts ${t.path.join(' → ')}: ${t.amount.toLocaleString()} Buzz (loop ${loopKey(
          t
        )})`
    )
    .join('; ');
  const more = transfers.length - INDIRECT_PATHS_SHOWN;
  return (
    `Since ${since
      .toISOString()
      .slice(
        0,
        10
      )} this creator sent Buzz to other accounts that, in turn, paid it on and back to them as bankable earnings (${shown}${
      more > 0 ? `; and ${more} more` : ''
    }). ` +
    `Each amount is the smallest leg of totals since then; the order of the transfers is not checked.`
  );
}

export function renderIndirectReason(
  transfers: IndirectTransfer[],
  since: Date,
  firstFiledAt?: Date
): string {
  const earlier = firstFiledAt ? ` First filed on ${day(firstFiledAt)} for a direct exchange.` : '';
  return truncateReason(
    `Whether this is abuse is a moderator decision.${earlier} ${NO_ACTION_TAKEN} ${describeIndirect(
      transfers,
      since
    )}`
  );
}

export function toIndirectFinding(
  userId: number,
  transfers: IndirectTransfer[],
  since: Date,
  firstFiledAt?: Date
): Finding {
  return {
    userId,
    confidence: INDIRECT_CONFIDENCE,
    reason: renderIndirectReason(transfers, since, firstFiledAt),
    actioned: false,
  };
}

export function renderSummary(counts: {
  pairs: number;
  members: number;
  filed: number;
  repeats: number;
  indirect: number;
}): string {
  return (
    `${counts.pairs.toLocaleString()} creator-to-user ${plural(
      counts.pairs,
      'pair'
    )} exchanged Buzz in both directions over the review amount; ` +
    `${counts.members.toLocaleString()} ${plural(
      counts.members,
      'was',
      'were'
    )} current Creator Program ${plural(counts.members, 'member')}. ` +
    `${counts.filed} filed for the first time, ${counts.repeats} filed again after the exchange grew. ` +
    `${counts.indirect} of the filed members also or only had indirect transfers.`
  );
}
