import type { AbuseReportInput } from '@civitai/moderation';
import { detectionConfig, type WithdrawalAccount } from './detect';

type Finding = AbuseReportInput['findings'][number];

/** The wire contract's own cap. Restated because the truncation below is arithmetic on it, and a
 *  literal in two places drifts. */
const MAX_REASON_LENGTH = 2_000;

/**
 * 🔴 EVERY NUMBER THE RULE USED GOES IN THE REASON.
 *
 * A moderator's first question about an automated finding is "how do you know", and the row is the
 * only place they can be told. The three that decide it are the withdrawal count, the share of the
 * account's reactions that is withdrawals, and the account's age — so all three are stated, with the
 * denominator, rather than a score they would have to trust.
 *
 * The withdrawal SHARE is the one to read: 1,204 withdrawals out of 1,210 reactions is a machine;
 * 1,204 out of 40,000 is a heavy user with a flaky client. Both clear the volume threshold.
 */
export function renderReason(a: WithdrawalAccount): string {
  // Floored, not rounded: 1,204 of 1,210 rounds to "100%", and a moderator reading that number has
  // to be able to take it literally — "100% of their reactions were withdrawn" is a claim about
  // every one of them, and 99% is the honest rendering of all but six.
  const share = a.given > 0 ? Math.floor((a.cycles / a.given) * 100) : null;
  const parts = [
    `${a.cycles.toLocaleString()} reactions given and withdrawn within ${
      detectionConfig.INSTANT_SECONDS
    }s, in ${detectionConfig.WINDOW_DAYS} days` +
      (share === null
        ? '.'
        : ` — ${share}% of the ${a.given.toLocaleString()} reactions this account gave.`),
    `Spread across ${a.creators.toLocaleString()} creators.`,
    `Account is ${a.ageDays} day(s) old${
      a.instantVerify === null
        ? ''
        : a.instantVerify
        ? ', email verified within 2 minutes of signup'
        : ''
    }.`,
    // The calibration, on every row, because a moderator has no other way to know how much a finding
    // from this detector is worth — and because a rate that drifts should be visible on the rows it
    // was measured for. Re-measure before changing it.
    `Rule concordance when last measured (2026-09-09): 98.9% of accounts matching this pattern were already banned, against 0.075% of accounts with the same reaction volume and no withdrawals.`,
  ];
  return truncateReason(parts.join(' '));
}

/** 🔴 A reason over the contract's limit does not lose the finding, it 400s the REPORT and loses
 *  every finding in the batch. Truncated here; the ellipsis is the record that something was cut. */
export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  return reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`;
}

/**
 * 🔴 CONFIDENCE IS THE QUEUE'S SORT ORDER, NOT A PROBABILITY.
 *
 * `getAbuseFindings` on the board orders by `confidence DESC`, and this detector has ONE rule — every
 * finding either matched it or is absent — so a per-account probability would be invented. The floor
 * is what the rule as a whole measured; the band above it exists only to put the strongest evidence
 * at the top of the page, and it is deliberately narrow so nobody reads the spread as meaning.
 *
 * Volume and share are weighted equally: a high count alone is a heavy user, a high share alone can
 * be six withdrawals out of six.
 */
export function confidenceFor(a: WithdrawalAccount): number {
  const volume = Math.min(1, a.cycles / 200);
  const share = a.given > 0 ? Math.min(1, a.cycles / a.given) : 0;
  return Math.round((0.9 + 0.09 * (0.5 * volume + 0.5 * share)) * 100) / 100;
}

/**
 * 🔴 `actioned: false` IS A LITERAL, AND MUST STAY ONE. This detector holds no write client and no
 * enforcement service; the abuse board's ingress is write-only by design, so a finding grants nothing
 * and bans nobody. Turning it live is a code change here, not a configuration.
 */
export function toFinding(a: WithdrawalAccount): Finding {
  return {
    userId: a.userId,
    confidence: confidenceFor(a),
    reason: renderReason(a),
    actioned: false,
  };
}

export function renderSummary(accounts: WithdrawalAccount[], scanned: number): string {
  if (!accounts.length)
    return `No live accounts over the threshold. ${scanned.toLocaleString()} matched the withdrawal pattern; all were already banned, deleted, or older than ${
      detectionConfig.MAX_ACCOUNT_AGE_DAYS
    } days.`;
  const cycles = accounts.reduce((sum, a) => sum + a.cycles, 0);
  return `${accounts.length.toLocaleString()} live account(s) withdrew ${cycles.toLocaleString()} reactions within ${
    detectionConfig.INSTANT_SECONDS
  }s of giving them, over ${
    detectionConfig.WINDOW_DAYS
  } days. ${scanned.toLocaleString()} accounts matched the pattern in total; the rest were already banned, deleted, or over ${
    detectionConfig.MAX_ACCOUNT_AGE_DAYS
  } days old.`;
}
