// Prometheus metrics for Knights, scraped from `/metrics`. Labels are bounded enums only: never a user, image or
// item id. Every counter is seeded with its full label set so each series exports 0 before its first event.
import { Counter, Registry, collectDefaultMetrics } from 'prom-client';
import {
  KNIGHTS_ESCALATION_REASONS,
  KNIGHTS_STAGE_RANKS,
  KNIGHTS_WRITEBACK_REASONS,
} from '@civitai/shared/new-order';
import { logToAxiom } from './axiom';
import { loadGaugeSnapshot, registerGauges } from './metrics/gauges';

export const register = new Registry();
collectDefaultMetrics({ register });

const VOTE_KINDS = ['rating', 'yesno', 'hidden_check'] as const;
const GOLD_SOURCES = ['vote', 'hidden_check', 'streak_bonus'] as const;
const SHOP_ITEM_KINDS = ['buzz_pack', 'cosmetic', 'membership'] as const;
const SHOP_OUTCOMES = ['granted', 'pending', 'failed'] as const;
const BUZZ_OUTCOMES = ['paid', 'failed', 'retry'] as const;
const ESCALATION_REASONS = [
  'next-stage',
  ...new Set([...KNIGHTS_ESCALATION_REASONS, ...KNIGHTS_WRITEBACK_REASONS]),
] as const;
const HIDDEN_VERDICTS = ['correct', 'failed', 'inconclusive'] as const;

export type VoteKind = (typeof VOTE_KINDS)[number];
export type GoldSource = (typeof GOLD_SOURCES)[number];
export type BuzzOutcome = (typeof BUZZ_OUTCOMES)[number];
export type ShopOutcome = (typeof SHOP_OUTCOMES)[number];

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

const votes = counter('knights_votes_total', 'Votes written to the ledger, by kind.', {
  kind: VOTE_KINDS,
});
const goldEarned = counter(
  'knights_gold_earned_total',
  'Gold moved to earned: settled correct votes, graded hidden checks and Watch streak bonuses.',
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
  'Queue items handed to the next stage (next-stage) or to the Inquisitors, by reason.',
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
const careerResets = counter(
  'knights_career_resets_total',
  'Career resets done in the main app after a player reached the smite limit.'
);
const joins = counter('knights_joins_total', 'Players who joined the Order.');
const rankUps = counter('knights_rank_ups_total', 'Rank-ups from settled votes, by new rank.', {
  rank: KNIGHTS_STAGE_RANKS,
});
const unhandledErrors = counter(
  'knights_unhandled_errors_total',
  'Unhandled server errors caught by the SvelteKit handleError hook.'
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
  vote: (kind: VoteKind) => safely(() => votes.inc({ kind })),
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
  unhandledError: () => safely(() => unhandledErrors.inc()),
  // No table records these three, so each also leaves one Axiom event.
  careerReset: (playerId: number) => {
    safely(() => careerResets.inc());
    void logToAxiom({
      type: 'info',
      name: 'knights-career-reset',
      message: 'A career was reset after the smite limit',
      details: { playerId },
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
