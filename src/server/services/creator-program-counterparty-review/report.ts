import { MAX_REASON_LENGTH, type AbuseReportInput } from '@civitai/moderation';
import { NO_ACTION_TAKEN, plural } from '../abuse-report-prose';
import type { CounterpartyPair, IndirectTransfer } from './detect';

type Finding = AbuseReportInput['findings'][number];

/** The `action` recorded when the review sent the warning message. */
export const WARNED_ACTION = 'warned';

/**
 * The message a creator receives the first time the review files them. Sent from the Civitai
 * account as a direct message.
 */
export function renderWarningMessage(username: string | null) {
  const name = username ? username.replace(/[\\*_[\]`<>]/g, '\\$&') : 'there';
  return [
    `Hi ${name},`,
    `Our systems noticed Buzz moving back and forth between your account and another account through tips, donations or purchases. Buzz that circulates like this does not count toward your bankable Creator Program earnings, and using it to raise them is against the Creator Program rules.`,
    `Consider this your one and only warning. If it happens again, your account will be removed from the Creator Program.`,
    `If you think we got this wrong, for example you and a collaborator genuinely support each other's work, [contact support](/support) and a moderator will review it.`,
    `— Civitai Moderation`,
  ].join('\n\n');
}

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

export type ReviewOutcome =
  | { kind: 'warned'; chatId: number }
  | { kind: 'warning-failed'; error: string }
  | { kind: 'repeat'; warnedAt: Date };

/**
 * The amounts the review compared go in the reason, so a moderator can check the finding without
 * trusting a score. The window is stated once: everything is since the bankable cutover.
 */
export function renderReason(
  pairs: CounterpartyPair[],
  outcome: ReviewOutcome,
  since: Date,
  indirect: IndirectTransfer[] = []
): string {
  const total = pairs.reduce((sum, p) => sum + twoWay(p), 0);
  const window = `since ${since.toISOString().slice(0, 10)}`;
  const head =
    `Exchanged Buzz in both directions with ${pairs.length} ${plural(
      pairs.length,
      'account'
    )} ${window} ` +
    `(${describePairs(
      pairs
    )}). ${total.toLocaleString()} Buzz went both ways and was left out of their bankable earnings.${
      indirect.length ? ` ${describeIndirect(indirect, since)}` : ''
    }`;

  switch (outcome.kind) {
    case 'warned':
      return truncateReason(`${head} Sent the one-time warning message from the Civitai account.`);
    case 'warning-failed':
      return truncateReason(
        `${head} The warning message could not be sent (${outcome.error}); it will be retried on the next run. ${NO_ACTION_TAKEN}`
      );
    case 'repeat':
      return truncateReason(
        `${head} Already warned on ${outcome.warnedAt
          .toISOString()
          .slice(
            0,
            10
          )}, and the exchange grew again after that. Removing the account from the Creator Program is a moderator decision. ${NO_ACTION_TAKEN}`
      );
  }
}

/** Repeats sort above first warnings: they are the rows that need a moderator. */
export function toFinding(
  userId: number,
  pairs: CounterpartyPair[],
  outcome: ReviewOutcome,
  since: Date,
  indirect: IndirectTransfer[] = []
): Finding {
  const reason = renderReason(pairs, outcome, since, indirect);
  if (outcome.kind === 'warned')
    return { userId, confidence: 0.9, reason, actioned: true, action: WARNED_ACTION };
  return { userId, confidence: outcome.kind === 'repeat' ? 0.95 : 0.9, reason, actioned: false };
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

export function renderIndirectReason(transfers: IndirectTransfer[], since: Date): string {
  return truncateReason(
    `No warning message was sent: whether this is abuse is a moderator decision. ${NO_ACTION_TAKEN} ${describeIndirect(
      transfers,
      since
    )}`
  );
}

export function toIndirectFinding(
  userId: number,
  transfers: IndirectTransfer[],
  since: Date
): Finding {
  return {
    userId,
    confidence: INDIRECT_CONFIDENCE,
    reason: renderIndirectReason(transfers, since),
    actioned: false,
  };
}

export function renderSummary(counts: {
  pairs: number;
  members: number;
  warned: number;
  repeats: number;
  failed: number;
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
    `${counts.warned} warned for the first time, ${counts.repeats} filed again after a warning, ${counts.failed} could not be messaged. ` +
    `${counts.indirect} filed for indirect transfers.`
  );
}
