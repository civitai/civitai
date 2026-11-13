import {
  composeLabel,
  disagreement,
  FLAGGING_PROPOSALS,
  type Disagreement,
  type MinorBucket,
  type ProposedLabel,
} from './compose';
import {
  MINOR_ANSWERS,
  parseAnswers,
  QUESTION_IDS,
  type Answers,
  type QuestionId,
} from './questions';

export type Arm = 'image' | 'image_signals' | 'signals';

export type ReportItem = {
  itemId: string;
  imageId: number;
  stratum: 'removed' | 'not_removed';
  bucket: MinorBucket | null;
  appealStatus: string | null;
};

/** One labeler's answers. */
export type HumanLabel = { itemId: string; labelerId: number; answers: Answers };

/** One model arm's per-question output, as the eval harness writes it. */
export type PredictedAnswer = { choice: string; confidence: number; abstained: boolean };
export type Prediction = {
  itemId: string;
  arm: Arm;
  answers: Partial<Record<QuestionId, PredictedAnswer>>;
};

/** Private per-question thresholds; values never live in the repo. */
export type Thresholds = Record<QuestionId, number>;

/** Below its threshold, or abstained, an answer counts as `cannot_tell`, which blocks a proposal. */
export function thresholdAnswers(p: Prediction, t: Thresholds): Answers | null {
  const raw: Partial<Record<QuestionId, string>> = {};
  for (const id of QUESTION_IDS) {
    const a = p.answers[id];
    raw[id] = !a || a.abstained || a.confidence < t[id] ? 'cannot_tell' : a.choice;
  }
  return parseAnswers(raw);
}

/**
 * What a model proposal may do to enforcement. Monotone: never less strict than what the rules did.
 * A removed item stays removed (the proposal changes only its label); a kept item can gain a hold.
 */
export function combineOutcome(
  rule: 'removed' | 'kept',
  proposal: ProposedLabel | null
): 'removed' | 'hold' | 'kept' {
  if (rule === 'removed') return 'removed';
  return proposal !== null && FLAGGING_PROPOSALS.has(proposal) ? 'hold' : 'kept';
}

/**
 * The relabel gold for an item: the composed label, only when exactly two labelers both produced
 * one and it is the same. A contested or incomplete item has no gold.
 */
export function goldLabel(labels: HumanLabel[]): ProposedLabel | null {
  if (labels.length !== 2) return null;
  const [a, b] = labels.map((l) => composeLabel(l.answers));
  return a !== null && a === b ? a : null;
}

/** Both labelers called a minor present. The recall denominator for the A4 promotion rule. */
export function goldMinor(labels: HumanLabel[]): boolean {
  return labels.length === 2 && labels.every((l) => MINOR_ANSWERS.has(l.answers.minorPresent));
}

export function cohenKappa(pairs: [string, string][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const countA = new Map<string, number>();
  const countB = new Map<string, number>();
  for (const [a, b] of pairs) {
    countA.set(a, (countA.get(a) ?? 0) + 1);
    countB.set(b, (countB.get(b) ?? 0) + 1);
  }
  let expected = 0;
  for (const [k, ca] of countA) expected += (ca / n) * ((countB.get(k) ?? 0) / n);
  if (expected === 1) return observed === 1 ? 1 : null;
  return (observed - expected) / (1 - expected);
}

/** Wilson 95% interval lower bound for k successes in n. */
export function wilsonLower(k: number, n: number): number | null {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / denom;
}

export type DisagreementRow = {
  itemId: string;
  imageId: number;
  stratum: 'removed' | 'not_removed';
  bucket: MinorBucket | null;
  arm: Arm;
  ruleOutcome: 'removed' | 'kept';
  proposal: ProposedLabel | null;
  combined: 'removed' | 'hold' | 'kept';
  disagreement: Disagreement | null;
  gold: ProposedLabel | null;
  /** Null when there is no gold to judge by. */
  proposalMatchesGold: boolean | null;
};

/** One row per (item, arm) prediction, the shape the A5 comparison view consumes. */
export function disagreementRows(
  items: ReportItem[],
  labels: HumanLabel[],
  predictions: Prediction[],
  thresholds: Thresholds
): DisagreementRow[] {
  const byItem = new Map(items.map((i) => [i.itemId, i]));
  const labelsByItem = groupBy(labels, (l) => l.itemId);
  const rows: DisagreementRow[] = [];
  for (const p of predictions) {
    const item = byItem.get(p.itemId);
    if (!item) continue;
    const answers = thresholdAnswers(p, thresholds);
    const proposal = answers ? composeLabel(answers) : null;
    const gold = goldLabel(labelsByItem.get(item.itemId) ?? []);
    const ruleOutcome = item.stratum === 'removed' ? 'removed' : 'kept';
    rows.push({
      itemId: item.itemId,
      imageId: item.imageId,
      stratum: item.stratum,
      bucket: item.bucket,
      arm: p.arm,
      ruleOutcome,
      proposal,
      combined: combineOutcome(ruleOutcome, proposal),
      disagreement:
        proposal === null
          ? null
          : disagreement(
              item.stratum === 'removed'
                ? { stratum: 'removed', bucket: item.bucket as MinorBucket }
                : { stratum: 'not_removed' },
              proposal
            ),
      gold,
      proposalMatchesGold: gold === null || proposal === null ? null : proposal === gold,
    });
  }
  return rows;
}

export type ArmSummary = {
  arm: Arm;
  predictions: number;
  /** Share with a proposal at all (every answer cleared its threshold). */
  covered: number;
  removedDisagreeing: Partial<Record<Disagreement, number>>;
  notRemovedFlagging: Partial<Record<Disagreement, number>>;
  /** Of disagreeing rows that have gold, how many the proposal got right. The ≥80% bar. */
  disagreeingWithGold: number;
  disagreeingRight: number;
  disagreeingRightLower: number | null;
  /** Of gold-minor items, how many this arm also called a minor (at threshold). */
  minorRecall: { hit: number; of: number };
  /** Approved-appeal share among removed items with a resolved appeal, split by agreement. */
  appeals: {
    disagreeApproved: number;
    disagreeResolved: number;
    agreeApproved: number;
    agreeResolved: number;
  };
};

export function summarise(
  items: ReportItem[],
  labels: HumanLabel[],
  predictions: Prediction[],
  thresholds: Thresholds
): ArmSummary[] {
  const rows = disagreementRows(items, labels, predictions, thresholds);
  const byItem = new Map(items.map((i) => [i.itemId, i]));
  const labelsByItem = groupBy(labels, (l) => l.itemId);
  const predByKey = new Map(predictions.map((p) => [`${p.arm}:${p.itemId}`, p]));
  const arms = [...new Set(rows.map((r) => r.arm))];

  return arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const s: ArmSummary = {
      arm,
      predictions: mine.length,
      covered: mine.filter((r) => r.proposal !== null).length,
      removedDisagreeing: {},
      notRemovedFlagging: {},
      disagreeingWithGold: 0,
      disagreeingRight: 0,
      disagreeingRightLower: null,
      minorRecall: { hit: 0, of: 0 },
      appeals: { disagreeApproved: 0, disagreeResolved: 0, agreeApproved: 0, agreeResolved: 0 },
    };
    for (const r of mine) {
      if (r.disagreement) {
        const bucket = r.stratum === 'removed' ? s.removedDisagreeing : s.notRemovedFlagging;
        bucket[r.disagreement] = (bucket[r.disagreement] ?? 0) + 1;
        if (r.proposalMatchesGold !== null) {
          s.disagreeingWithGold++;
          if (r.proposalMatchesGold) s.disagreeingRight++;
        }
      }
      const appeal = byItem.get(r.itemId)?.appealStatus;
      if (
        r.stratum === 'removed' &&
        r.proposal !== null &&
        (appeal === 'Approved' || appeal === 'Rejected')
      ) {
        if (r.disagreement) {
          s.appeals.disagreeResolved++;
          if (appeal === 'Approved') s.appeals.disagreeApproved++;
        } else {
          s.appeals.agreeResolved++;
          if (appeal === 'Approved') s.appeals.agreeApproved++;
        }
      }
      if (goldMinor(labelsByItem.get(r.itemId) ?? [])) {
        s.minorRecall.of++;
        const p = predByKey.get(`${arm}:${r.itemId}`);
        const answers = p ? thresholdAnswers(p, thresholds) : null;
        if (answers && MINOR_ANSWERS.has(answers.minorPresent)) s.minorRecall.hit++;
      }
    }
    s.disagreeingRightLower = wilsonLower(s.disagreeingRight, s.disagreeingWithGold);
    return s;
  });
}

/**
 * A4's promotion rule: a signals arm is promoted only if it is at least as precise as image-only
 * when disagreeing AND calls minors at least as often on gold-minor items. Minor recall is the
 * failure that matters, so a tie on precision with lower recall is a rejection.
 */
export function signalsArmPromoted(image: ArmSummary, signals: ArmSummary): boolean {
  const rate = (k: number, n: number) => (n ? k / n : 0);
  const recallImage = rate(image.minorRecall.hit, image.minorRecall.of);
  const recallSignals = rate(signals.minorRecall.hit, signals.minorRecall.of);
  if (signals.minorRecall.of === 0 || recallSignals < recallImage) return false;
  return (
    rate(signals.disagreeingRight, signals.disagreeingWithGold) >
    rate(image.disagreeingRight, image.disagreeingWithGold)
  );
}

/** Per-question agreement between the two labelers: the human baseline. */
export function humanAgreement(
  labels: HumanLabel[]
): Record<QuestionId, { kappa: number | null; agree: number; of: number }> {
  const pairs = [...groupBy(labels, (l) => l.itemId).values()].filter((g) => g.length === 2);
  const out = {} as Record<QuestionId, { kappa: number | null; agree: number; of: number }>;
  for (const id of QUESTION_IDS) {
    const p = pairs.map((g) => [g[0].answers[id], g[1].answers[id]] as [string, string]);
    out[id] = { kappa: cohenKappa(p), agree: p.filter(([a, b]) => a === b).length, of: p.length };
  }
  return out;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}
