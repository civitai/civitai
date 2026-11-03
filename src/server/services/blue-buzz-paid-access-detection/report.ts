import { MAX_REASON_LENGTH, type AbuseReportInput } from '@civitai/moderation';
import { NO_ACTION_TAKEN, plural } from '../abuse-report-prose';
import type { Ring, RingBuyer, RingThresholds } from './detect';

type Finding = AbuseReportInput['findings'][number];

export const PROPOSED_ACTION =
  'Proposed action: review these buyers as one ring; consider revoking the paid-access grants they bought from this creator with Blue Buzz.';

/** Shared by every buyer in one ring, so the board groups them for one decision. It names only the
 *  creator, which every reason in the ring states. */
export const ringGroupKey = (ring: Ring) => `blue-paid-access:${ring.creatorId}`;

const day = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

/** Every number the rule used, about this buyer and this ring, so a moderator can check it. */
export function renderReason(
  ring: Ring,
  buyer: RingBuyer,
  { windowDays, minSharePct }: Pick<RingThresholds, 'windowDays' | 'minSharePct'>
): string {
  const others = ring.allBuyers - ring.buyers.length;
  const evidence = [
    `One of ${ring.buyers.length} accounts that bought paid access from creator ${ring.creatorId} with Blue Buzz in the last ${windowDays} days while sending at least ${minSharePct}% of their Blue Buzz paid-access spend to that creator.`,
    `This account: ${buyer.purchases} ${plural(buyer.purchases, 'purchase')} of ${
      buyer.versions
    } model ${plural(buyer.versions, 'version')}, ${buyer.spent.toLocaleString()} Blue Buzz, ${
      buyer.sharePct
    }% of the ${buyer.buyerTotal.toLocaleString()} Blue Buzz it spent on paid access, between ${day(
      buyer.firstAt
    )} and ${day(buyer.lastAt)} UTC.`,
    `Ring: ${ring.spent.toLocaleString()} Blue Buzz in ${ring.purchases} ${plural(
      ring.purchases,
      'purchase'
    )} between ${day(ring.firstAt)} and ${day(ring.lastAt)} UTC; ${others} other Blue Buzz ${plural(
      others,
      'buyer'
    )} of this creator spent less than ${minSharePct}% with them and ${plural(
      others,
      'is',
      'are'
    )} not included.`,
    NO_ACTION_TAKEN,
  ].join(' ');
  const tail = `\n${PROPOSED_ACTION}`;
  const room = MAX_REASON_LENGTH - tail.length;
  return `${evidence.length <= room ? evidence : `${evidence.slice(0, room - 1)}…`}${tail}`;
}

/**
 * 🔴 `actioned: false` IS A LITERAL, AND `action` IS ABSENT. This detector holds no write client;
 * a finding revokes nothing and bans nobody. Confidence is only the board's sort order: the buyer's
 * share of spend on this creator.
 */
export function toFinding(
  ring: Ring,
  buyer: RingBuyer,
  thresholds: Pick<RingThresholds, 'windowDays' | 'minSharePct'>
): Finding {
  return {
    userId: buyer.buyerId,
    confidence: Math.round((0.5 + 0.4 * Math.min(1, buyer.sharePct / 100)) * 100) / 100,
    reason: renderReason(ring, buyer, thresholds),
    actioned: false,
    groupKey: ringGroupKey(ring),
  };
}

export function renderSummary(
  rings: Ring[],
  pairs: number,
  { windowDays, minBuyers, minSharePct }: RingThresholds
): string {
  const buyers = rings.reduce((sum, r) => sum + r.buyers.length, 0);
  return (
    `${rings.length} ${plural(rings.length, 'creator')} with at least ${minBuyers} Blue Buzz ` +
    `paid-access buyers each sending at least ${minSharePct}% of their spend to them, and a ` +
    `purchase in the last day; ${buyers} ${plural(buyers, 'buyer')} filed. ` +
    `${pairs.toLocaleString()} creator-buyer ${plural(pairs, 'pair')} read over ${windowDays} days.`
  );
}
