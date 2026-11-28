// Prometheus metrics for Knights, scraped from `/metrics`. Labels are bounded enums only: never a user, image or
// item id. Every counter is seeded with its full label set so each series exports 0 before its first event.
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import type { RevocationOutcome } from '@civitai/auth';
import {
  KNIGHTS_ESCALATION_REASONS,
  KNIGHTS_STAGE_RANKS,
  KNIGHTS_WRITEBACK_REASONS,
} from '@civitai/shared/new-order';
import type { PressTiming } from '$lib/press';
import { logToAxiom } from './axiom';
import { loadGaugeSnapshot, registerGauges } from './metrics/gauges';

export const register = new Registry();
collectDefaultMetrics({ register });

const VOTE_KINDS = ['rating', 'yesno', 'hidden_check'] as const;
const GOLD_SOURCES = ['vote', 'hidden_check', 'streak_bonus', 'acolyte_level'] as const;
const RESET_TRIGGERS = ['smites', 'restart'] as const;
const NOTIFY_KINDS = ['verdicts', 'streak', 'new-images'] as const;
const SHOP_ITEM_KINDS = ['buzz_pack', 'cosmetic', 'membership'] as const;
const SHOP_OUTCOMES = ['granted', 'pending', 'failed'] as const;
const BUZZ_OUTCOMES = ['paid', 'failed', 'retry'] as const;
const ESCALATION_REASONS = [
  'next-stage',
  'expired',
  'unservable',
  'publishes-after-expiry',
  'unpublished-draft',
  'image-unservable',
  'no-consensus-rerate',
  ...new Set([...KNIGHTS_ESCALATION_REASONS, ...KNIGHTS_WRITEBACK_REASONS]),
] as const;
const HIDDEN_VERDICTS = ['correct', 'failed', 'inconclusive'] as const;
const SKILL_CHECK_RETIRE_REASONS = ['cap', 'failures'] as const;
const REVIEW_OUTCOMES = ['confirmed', 'split', 'excluded', 'expired'] as const;
const SKILL_CHECK_READ_SITES = [
  'pool-insert',
  'knight-serve',
  'knight-answer',
  'acolyte-serve',
  'review',
  'review-serve',
  'review-stats',
  'review-sweep',
  'notice',
  'recap',
  'judgments',
] as const;
export type SkillCheckReadSite = (typeof SKILL_CHECK_READ_SITES)[number];
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
export type SkillCheckRetireReason = (typeof SKILL_CHECK_RETIRE_REASONS)[number];
const REFUSAL_REASONS = [
  'no-player',
  'not-open',
  'unavailable',
  'not-eligible',
  'bad-answer',
  'bad-block-reason',
  'already-voted',
  'own-image',
  'no-weight',
  'reset-pending',
  'limited',
  'busy',
  'muted',
  'no-consent',
  'bad-token',
] as const;
const REFUSAL_KINDS = [...VOTE_KINDS, 'unknown'] as const;
const REFUSAL_ACTIONS = ['vote', 'skip'] as const;
export type RefusalKind = (typeof REFUSAL_KINDS)[number];
export type RefusalAction = (typeof REFUSAL_ACTIONS)[number];

const TICK_FAILURE_STEPS = [
  'writeback',
  'moderator_ruled',
  'payout',
  'yesno',
  'reset',
  'buzz_grant',
  'tag_writeback',
] as const;

export type VoteKind = (typeof VOTE_KINDS)[number];
export type GoldSource = (typeof GOLD_SOURCES)[number];
export type ResetTrigger = (typeof RESET_TRIGGERS)[number];
export type BuzzOutcome = (typeof BUZZ_OUTCOMES)[number];
export type ShopOutcome = (typeof SHOP_OUTCOMES)[number];
export type TickFailureStep = (typeof TICK_FAILURE_STEPS)[number];

type LabelValues = Record<string, readonly string[]>;

function counter(name: string, help: string, labels: LabelValues = {}) {
  const labelNames = Object.keys(labels);
  const metric = new Counter({ name, help, labelNames, registers: [register] });
  const combos = labelNames.reduce<Record<string, string>[]>(
    (acc, label) => acc.flatMap((combo) => labels[label].map((v) => ({ ...combo, [label]: v }))),
    [{}]
  );
  for (const combo of combos) metric.inc(combo, 0);
  return metric;
}

const bounded = (value: string, allowed: readonly string[]) =>
  allowed.includes(value) ? value : 'other';

const harvestSkipped = counter(
  'knights_harvest_skipped_rulings_total',
  'Moderator rulings the harvest passed over because they were older than its window when it reached them.'
);
const sessionCookieSlot = counter(
  'knights_session_cookie_slot_total',
  'Authenticated requests by the session cookie slot they were read from (host | shared).',
  { slot: ['host', 'shared'] }
);
const REVOCATION_OUTCOMES = [
  'hit',
  'timeout',
  'breaker-open',
  'error',
] as const satisfies readonly RevocationOutcome[];
const revocationChecks = counter(
  'knights_revocation_checks_total',
  'Session revocation reads by outcome (hit: the store answered).',
  { outcome: REVOCATION_OUTCOMES }
);
const votes = counter('knights_votes_total', 'Votes written to the ledger, by kind.', {
  kind: VOTE_KINDS,
});
const goldEarned = counter(
  'knights_gold_earned_total',
  'Gold moved to earned: settled correct votes, graded hidden checks, Watch streak bonuses and Acolyte levels.',
  { source: GOLD_SOURCES }
);
const goldSpent = counter(
  'knights_gold_spent_total',
  'Gold reserved by new shop purchases, by item kind (a purchase that fails later gives it back).',
  { item_kind: SHOP_ITEM_KINDS }
);
const shopPurchases = counter(
  'knights_shop_purchases_total',
  'New shop purchases by item kind and the answer the buyer got.',
  { item_kind: SHOP_ITEM_KINDS, outcome: SHOP_OUTCOMES }
);
const buzzGrants = counter(
  'knights_buzz_grants_total',
  'Buzz grant attempts behind shop Buzz packs, by outcome (retry: Buzz did not confirm).',
  { outcome: BUZZ_OUTCOMES }
);
const escalations = counter(
  'knights_escalations_total',
  'Queue items handed to the next stage (next-stage) or to the Inquisitors, by reason; expired counts unvoted items closed instead, no-consensus-rerate items re-rated to their most-voted level instead.',
  { reason: ESCALATION_REASONS }
);
const itemsResolved = counter(
  'knights_items_resolved_total',
  'Queue items resolved by a stage consensus, by stage.',
  { stage: KNIGHTS_STAGE_RANKS }
);
const hiddenChecksGraded = counter(
  'knights_hidden_checks_graded_total',
  'Hidden checks graded, by verdict.',
  { verdict: HIDDEN_VERDICTS }
);
const smites = counter('knights_smites_total', 'Smites issued by hidden-check grading.');
const reviewsClosed = counter(
  'knights_inquisitor_reviews_closed_total',
  'In-game inquisitor reviews closed, by outcome: two agreeing moderators, a split, or excluded (ruled, blocked, moved, held, or sent to the Inquisitors).',
  { outcome: REVIEW_OUTCOMES }
);
const skillCheckReadsUnreadable = counter(
  'knights_skill_check_reads_unreadable_total',
  'Skill-check safety reads that could not be read and failed closed, by where they ran.',
  { site: SKILL_CHECK_READ_SITES }
);
const overridesUnclosed = counter(
  'knights_inquisitor_overrides_unclosed_total',
  "Two agreeing moderators' level written to an image whose review could then not be closed (no skill check added)."
);
const skillChecksRetired = counter(
  'knights_skill_checks_retired_total',
  'Mod-confirmed skill checks retired, by reason: pushed out by the pool cap, or failed by too many Knights.',
  { reason: SKILL_CHECK_RETIRE_REASONS }
);
const careerResets = counter(
  'knights_career_resets_total',
  'Career resets, by trigger: the smite limit (done in the main app) or the player restarting.',
  { trigger: RESET_TRIGGERS }
);
const notificationsSent = counter(
  'knights_notifications_sent_total',
  'Daily-loop notifications handed to the notification service, by kind.',
  { kind: NOTIFY_KINDS }
);
const joins = counter('knights_joins_total', 'Players who joined the Order.');
const rankUps = counter('knights_rank_ups_total', 'Rank-ups, by new rank.', {
  rank: KNIGHTS_STAGE_RANKS,
});
const unhandledErrors = counter(
  'knights_unhandled_errors_total',
  'Unhandled server errors caught by the SvelteKit handleError hook.'
);
const tickItemFailures = counter(
  'knights_tick_item_failures_total',
  'Items that failed inside a tick step and wait for the next tick, by step.',
  { step: TICK_FAILURE_STEPS }
);

const voteRefusals = counter(
  'knights_vote_refusals_total',
  'Votes and skips the server refused, by reason, item kind (unknown before the token is opened) and action; the press did not count.',
  { reason: [...REFUSAL_REASONS, 'other'], kind: REFUSAL_KINDS, action: REFUSAL_ACTIONS }
);

registerGauges(register, loadGaugeSnapshot);

// Telemetry must never break the path that records it.
function safely(record: () => void) {
  try {
    record();
  } catch (error) {
    console.error('knights: recording a metric failed', error);
  }
}

export const metrics = {
  sessionCookieSlot: (slot: 'host' | 'shared') => safely(() => sessionCookieSlot.inc({ slot })),
  revocationCheck: (outcome: RevocationOutcome) =>
    safely(() => revocationChecks.inc({ outcome: bounded(outcome, REVOCATION_OUTCOMES) })),
  vote: (kind: VoteKind) => safely(() => votes.inc({ kind })),
  harvestSkipped: (count: number) =>
    safely(() => {
      if (count > 0) harvestSkipped.inc(count);
    }),
  goldEarned: (source: GoldSource, gold: number) =>
    safely(() => {
      if (gold > 0) goldEarned.inc({ source }, gold);
    }),
  shopPurchase: (itemKind: string, outcome: ShopOutcome, gold: number) =>
    safely(() => {
      const item_kind = bounded(itemKind, SHOP_ITEM_KINDS);
      shopPurchases.inc({ item_kind, outcome });
      if (gold > 0) goldSpent.inc({ item_kind }, gold);
    }),
  buzzGrant: (outcome: BuzzOutcome) => safely(() => buzzGrants.inc({ outcome })),
  escalation: (reason: string) =>
    safely(() => escalations.inc({ reason: bounded(reason, ESCALATION_REASONS) })),
  itemResolved: (stage: string) =>
    safely(() => itemsResolved.inc({ stage: bounded(stage, KNIGHTS_STAGE_RANKS) })),
  hiddenCheckGraded: (verdict: string) =>
    safely(() => hiddenChecksGraded.inc({ verdict: bounded(verdict, HIDDEN_VERDICTS) })),
  smite: () => safely(() => smites.inc()),
  reviewClosed: (outcome: ReviewOutcome) => safely(() => reviewsClosed.inc({ outcome })),
  overrideUnclosed: () => safely(() => overridesUnclosed.inc()),
  skillCheckReadUnreadable: (site: SkillCheckReadSite) =>
    safely(() => skillCheckReadsUnreadable.inc({ site })),
  skillChecksRetired: (reason: SkillCheckRetireReason, count: number) =>
    safely(() => {
      if (count > 0) skillChecksRetired.inc({ reason }, count);
    }),
  unhandledError: () => safely(() => unhandledErrors.inc()),
  tickItemFailures: (step: TickFailureStep, count: number) =>
    safely(() => {
      if (count > 0) tickItemFailures.inc({ step }, count);
    }),
  notificationsSent: (kind: string, count: number) =>
    safely(() => {
      if (count > 0) notificationsSent.inc({ kind: bounded(kind, NOTIFY_KINDS) }, count);
    }),
  // No table records a refused vote or skip, so each also leaves an Axiom event naming the player and the ledger item id
  // (negative for a hidden check; null before the token is opened). `press` adds the client's press timing to the row.
  voteRefused: (
    reason: string,
    kind: RefusalKind,
    playerId: number,
    itemId: number | null,
    action: RefusalAction,
    press?: PressTiming
  ) => {
    safely(() => voteRefusals.inc({ reason: bounded(reason, REFUSAL_REASONS), kind, action }));
    void logToAxiom({
      type: 'info',
      name: 'knights-vote-refused',
      message: `A ${action} was refused`,
      details: { reason, playerId },
      payload: { kind, itemId, action, ...press },
    });
  },
  // No table records these three, so each also leaves one Axiom event.
  careerReset: (playerId: number, trigger: ResetTrigger) => {
    safely(() => careerResets.inc({ trigger }));
    void logToAxiom({
      type: 'info',
      name: 'knights-career-reset',
      message: 'A career was reset',
      details: { playerId, trigger },
    });
  },
  join: (playerId: number) => {
    safely(() => joins.inc());
    void logToAxiom({
      type: 'info',
      name: 'knights-player-joined',
      message: 'A player joined the Order',
      details: { playerId },
    });
  },
  rankUp: (rank: string, playerId: number) => {
    safely(() => rankUps.inc({ rank: bounded(rank, KNIGHTS_STAGE_RANKS) }));
    void logToAxiom({
      type: 'info',
      name: 'knights-rank-up',
      message: 'A player ranked up',
      details: { playerId, rank },
    });
  },
};
