import { createHash } from 'crypto';
import pLimit from 'p-limit';
import { TRPCError } from '@trpc/server';
import {
  APP_BUZZ_REFUND_TYPE,
  appBuzzRefundNotifications,
  type AppBuzzRefundDetails,
} from '~/server/notifications/app-buzz-refund.notifications';
import { refundTransactionOnce } from '~/server/services/buzz-prefix-refund';
import { getTransactionByExternalId } from '~/server/services/buzz.service';
import { STATUS_ACCRUED } from '~/server/services/blocks/author-fee-accrual.service';
import {
  blockAuthorFeeChargeKey,
  blockAuthorFeeReversalKey,
  refundBlockAuthorFee,
  reverseBlockAuthorFee,
} from '~/server/services/blocks/author-fee-charge.service';
import { isSettlementEligible } from '~/server/services/blocks/author-fee-settlement.service';
import {
  getAppFeedbackForRefund,
  modResolveAppFeedbackWithRefund,
} from '~/server/services/blocks/app-feedback.service';
import {
  getAppNames,
  getAppWorkflowRecords,
  getOrchestratorWorkflowCharges,
  listAppWorkflowIdsForUser,
  type AppWorkflowRecords,
} from '~/server/services/blocks/app-workflow-refund.data';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import { APP_BLOCK_FEEDBACK_AREA } from '~/shared/constants/feedback.constants';

// Moderator refund of App Blocks spend, for a SUCCEEDED workflow that delivered nothing. It moves
// money — the user's generation legs, found by id on the orchestrator's own `transactions.list` (they
// carry no external id prefix), and the app author's fee, charged and returned under
// `block-author-fee-charge-` / `block-author-fee-reversal-<workflowId>` — and then, after the money
// has moved and never undoing it, writes the linked feedback note/status and sends the notification.

export const APP_REFUND_CAP_BUZZ = 5_000;
export const APP_REFUND_MAX_WORKFLOWS = 50;
/** The Buzz transaction description. Shown in the user's own history, so never the moderator's text. */
export const APP_REFUND_DESCRIPTION = 'Refund: App generation not delivered';

/**
 * Only a SUCCEEDED workflow is refunded here: that is the case nothing else returns money for. A
 * failed, expired or canceled one is refunded by the orchestrator itself (and its fee reversed by the
 * poll observers); a running one can still be charged, credited or refunded.
 */
const REFUNDABLE_STATUS = 'succeeded';
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);
/** A Buzz transaction id. A fund-backed workflow records `fund-<id>` instead, which is no ledger row. */
const BUZZ_TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSPECT_CONCURRENCY = 5;

/** Every reason the planner skips a workflow — the lookup reports the same one. */
export const SKIP_REASONS = [
  'not-app-blocks',
  'workflow-not-found',
  'mixed-users',
  'not-terminal',
  'not-succeeded',
  'unsupported-charge',
  'charges-unreadable',
  'orchestrator-partial-refund',
  'no-charges',
  'lookup-failed',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type ChargeLeg = {
  /** The Buzz transaction id the orchestrator recorded for this debit. */
  transactionId: string;
  amount: number;
  buzzType: string;
  /**
   * `moderator`: `refund-<transactionId>` is on the ledger. `orchestrator`: the orchestrator's own
   * credits cover this leg's colour in full. `null`: still charged.
   */
  refundedBy: 'moderator' | 'orchestrator' | null;
  refundTransactionId: string | null;
};

export type AuthorFeeState = 'none' | 'unsettled' | 'settled' | 'unaccrued' | 'reversed';

export type AuthorFeeInfo = {
  /**
   * `unsettled`: the accrual day is still open, so the fee can be reversed. `settled`: the day has
   * closed (whether or not the settlement run has flipped the row), so the author may have been paid.
   * `unaccrued`: the viewer was debited and no accrual says who is owed it. `reversed`: already
   * returned to the viewer.
   */
  state: AuthorFeeState;
  feeBuzz: number;
  buzzType: string | null;
  accruedAt: Date | null;
  refundTransactionId: string | null;
};

export type AuthorFeeTreatment =
  | 'none'
  | 'reversed'
  | 'platform-absorbed'
  | 'refunded'
  | 'already-refunded';

type Inspection =
  | {
      kind: 'skip';
      workflowId: string;
      reason: SkipReason;
      detail?: string;
      userId: number | null;
      appBlockId: string | null;
      recordedStatus: string | null;
      submittedAt: Date | null;
    }
  | {
      kind: 'ok';
      workflowId: string;
      userIds: number[];
      appBlockId: string | null;
      recordedStatus: string | null;
      submittedAt: Date | null;
      orchestratorStatus: string;
      legs: ChargeLeg[];
      unsupportedLegs: number;
      partiallyCreditedColours: string[];
      /** The submit recorded a paid spend (`block_spend_attribution.buzz_amount > 0`). */
      recordedPaidSpend: boolean;
      authorFee: AuthorFeeInfo;
    };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Each workflow is a few ledger reads and one orchestrator read; a few at a time, in input order. */
function inspectAll(workflowIds: string[], records: AppWorkflowRecords, now: Date) {
  const limit = pLimit(INSPECT_CONCURRENCY);
  return Promise.all(workflowIds.map((id) => limit(() => inspectWorkflow(id, records, now))));
}

function recordFacts(workflowId: string, records: AppWorkflowRecords) {
  const workflows = records.workflows.filter((r) => r.workflowId === workflowId);
  const spends = records.spends.filter((r) => r.workflowId === workflowId);
  const fees = records.fees.filter((r) => r.workflowId === workflowId);
  const userIds = new Set<number>([
    ...workflows.map((r) => r.userId),
    ...spends.map((r) => r.userId),
    ...fees.map((r) => r.viewerUserId),
  ]);
  const appBlockId =
    workflows[0]?.appBlockId ?? spends[0]?.appBlockId ?? fees[0]?.appBlockId ?? null;
  const submittedAt =
    workflows[0]?.submittedAt ?? spends[0]?.attributedAt ?? fees[0]?.accruedAt ?? null;
  return {
    found: workflows.length + spends.length + fees.length > 0,
    userIds,
    appBlockId,
    recordedStatus: workflows[0]?.status ?? null,
    submittedAt,
    accrual: fees[0] ?? null,
    recordedPaidSpend: spends.some((r) => r.buzzAmount > 0),
  };
}

/**
 * Everything the platform and the ledger say about one workflow's money. Read-only; a failure to
 * read anything is reported as `lookup-failed`, never guessed past.
 */
async function inspectWorkflow(
  workflowId: string,
  records: AppWorkflowRecords,
  now: Date
): Promise<Inspection> {
  const facts = recordFacts(workflowId, records);
  const base = {
    workflowId,
    appBlockId: facts.appBlockId,
    recordedStatus: facts.recordedStatus,
    submittedAt: facts.submittedAt,
  };
  const onlyUser = () => (facts.userIds.size === 1 ? [...facts.userIds][0] : null);
  if (!facts.found)
    return { kind: 'skip', ...base, reason: 'not-app-blocks', userId: null, appBlockId: null };

  try {
    const [feeCharge, feeReversal, orchestrator] = await Promise.all([
      getTransactionByExternalId(blockAuthorFeeChargeKey(workflowId)),
      getTransactionByExternalId(blockAuthorFeeReversalKey(workflowId)),
      getOrchestratorWorkflowCharges(workflowId),
    ]);
    if (feeCharge) facts.userIds.add(feeCharge.fromAccountId);
    if (feeReversal) facts.userIds.add(feeReversal.toAccountId);
    if (!orchestrator.found)
      return { kind: 'skip', ...base, reason: 'workflow-not-found', userId: onlyUser() };

    const debits = orchestrator.transactions.filter((t) => t.type === 'debit' && t.amount > 0);
    const credits = orchestrator.transactions.filter((t) => t.type === 'credit' && t.amount > 0);
    const unsupportedLegs = debits.filter((t) => !t.id || !BUZZ_TRANSACTION_ID.test(t.id)).length;

    const legs: ChargeLeg[] = [];
    for (const debit of debits) {
      if (!debit.id || !BUZZ_TRANSACTION_ID.test(debit.id)) continue;
      const refundId = `refund-${debit.id}`;
      const refund = await getTransactionByExternalId(refundId);
      if (refund) facts.userIds.add(refund.toAccountId);
      legs.push({
        transactionId: debit.id,
        amount: debit.amount,
        buzzType: debit.accountType,
        refundedBy: refund ? 'moderator' : null,
        refundTransactionId: refund ? refundId : null,
      });
    }

    // A leg is refunded whole or not at all — Buzz has no partial refund of a transaction.
    // The orchestrator's own credits, per colour. EXACTLY the debited amount: every leg of that
    // colour is settled. Anything else — part of it, more than it, or a credit in a colour nothing
    // was debited in — means the orchestrator's books for this workflow are not a whole-leg picture,
    // and refunding legs on top of them could over-refund, so the whole workflow is refused.
    const partiallyCreditedColours: string[] = [];
    const colours = new Set(credits.map((c) => c.accountType));
    for (const colour of colours) {
      const credited = credits
        .filter((c) => c.accountType === colour)
        .reduce((sum, c) => sum + c.amount, 0);
      const debited = debits
        .filter((d) => d.accountType === colour)
        .reduce((sum, d) => sum + d.amount, 0);
      if (debited > 0 && credited === debited) {
        for (const leg of legs)
          if (leg.buzzType === colour && !leg.refundedBy) leg.refundedBy = 'orchestrator';
      } else partiallyCreditedColours.push(colour);
    }

    let authorFee: AuthorFeeInfo = {
      state: 'none',
      feeBuzz: 0,
      buzzType: null,
      accruedAt: null,
      refundTransactionId: null,
    };
    if (feeReversal) {
      authorFee = {
        state: 'reversed',
        feeBuzz: feeReversal.amount,
        buzzType: feeReversal.toAccountType,
        accruedAt: facts.accrual?.accruedAt ?? null,
        refundTransactionId: blockAuthorFeeReversalKey(workflowId),
      };
    } else if (facts.accrual) {
      // The day, not the status word, decides — the same guard `reverseBlockAuthorFee` applies.
      const reversible =
        facts.accrual.status === STATUS_ACCRUED &&
        !isSettlementEligible(facts.accrual.accruedAt, now);
      authorFee = {
        state: reversible ? 'unsettled' : 'settled',
        feeBuzz: facts.accrual.feeBuzz,
        buzzType: facts.accrual.buzzType,
        accruedAt: facts.accrual.accruedAt,
        refundTransactionId: null,
      };
    } else if (feeCharge) {
      authorFee = {
        state: 'unaccrued',
        feeBuzz: feeCharge.amount,
        buzzType: feeCharge.fromAccountType,
        accruedAt: null,
        refundTransactionId: null,
      };
    }

    return {
      kind: 'ok',
      ...base,
      userIds: [...facts.userIds],
      orchestratorStatus: orchestrator.status,
      legs,
      unsupportedLegs,
      partiallyCreditedColours,
      recordedPaidSpend: facts.recordedPaidSpend,
      authorFee,
    };
  } catch (error) {
    return {
      kind: 'skip',
      ...base,
      reason: 'lookup-failed',
      detail: errorMessage(error),
      userId: onlyUser(),
    };
  }
}

export type RefundState = 'none' | 'partial' | 'full';

function refundState(legs: ChargeLeg[], fee: AuthorFeeInfo): RefundState {
  const items = [
    ...legs.map((l) => l.refundedBy !== null),
    ...(fee.state === 'none' ? [] : [fee.state === 'reversed']),
  ];
  if (items.length === 0 || items.every((done) => !done)) return 'none';
  return items.every((done) => done) ? 'full' : 'partial';
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const WORKFLOW_CHARGES_DEFAULT_DAYS = 30;
export const WORKFLOW_CHARGES_MAX_DAYS = 90;

/**
 * `[from, to)`: `to` defaults to now and `from` to WORKFLOW_CHARGES_DEFAULT_DAYS before `to`. Refuses
 * an empty or inverted window and one wider than WORKFLOW_CHARGES_MAX_DAYS — the lookup reads the orchestrator once per workflow, so the
 * window is what bounds it alongside `limit`.
 */
export function resolveChargesWindow(input: { from?: Date; to?: Date }, now: Date) {
  const to = input.to ?? now;
  const from = input.from ?? new Date(to.getTime() - WORKFLOW_CHARGES_DEFAULT_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime())
    throw new TRPCError({ code: 'BAD_REQUEST', message: '`from` must be before `to`' });
  if (to.getTime() - from.getTime() > WORKFLOW_CHARGES_MAX_DAYS * DAY_MS)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `The window may span at most ${WORKFLOW_CHARGES_MAX_DAYS} days`,
    });
  return { from, to };
}

export async function lookupAppWorkflowCharges(input: {
  userId: number;
  appBlockId?: string;
  from: Date;
  to: Date;
  limit: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const workflowIds = await listAppWorkflowIdsForUser(input);
  const records = await getAppWorkflowRecords(workflowIds);
  const inspections = await inspectAll(workflowIds, records, now);
  const names = await getAppNames([
    ...new Set(inspections.map((i) => i.appBlockId).filter((id): id is string => !!id)),
  ]);

  return {
    userId: input.userId,
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    workflows: inspections.map((i) => {
      const app = i.appBlockId ? { id: i.appBlockId, name: names.get(i.appBlockId) ?? null } : null;
      const common = {
        workflowId: i.workflowId,
        app,
        submittedAt: i.submittedAt?.toISOString() ?? null,
        recordedStatus: i.recordedStatus,
      };
      // What would stop `/api/mod/apps/refund-workflows` refunding it: the refund PLANNER's own skip
      // reason, so the preview and the refund cannot disagree about which workflows get skipped.
      const plan = planWorkflow(i);
      const refundBlocker = plan.outcome === 'skip' ? plan.reason : null;
      if (i.kind === 'skip')
        return {
          ...common,
          orchestratorStatus: null,
          refundBlocker,
          ...(i.detail ? { lookupError: i.detail } : {}),
        };
      return {
        ...common,
        orchestratorStatus: i.orchestratorStatus,
        charges: i.legs,
        authorFee: {
          ...i.authorFee,
          accruedAt: i.authorFee.accruedAt?.toISOString() ?? null,
        },
        refundState: refundState(i.legs, i.authorFee),
        refundTransactionIds: [
          ...i.legs.map((l) => l.refundTransactionId),
          i.authorFee.refundTransactionId,
        ].filter((id): id is string => !!id),
        refundBlocker,
      };
    }),
  };
}

type FeePlan = {
  state: AuthorFeeState;
  treatment: AuthorFeeTreatment;
  /** What the viewer gets back for the fee in this call: 0 unless the treatment returns money. */
  refundBuzz: number;
  feeBuzz: number;
  buzzType: string | null;
};

type SkipPlan = {
  outcome: 'skip';
  workflowId: string;
  reason: SkipReason;
  detail?: string;
  userId: number | null;
  appBlockId: string | null;
};

type RefundablePlan = {
  /** `already-refunded`: nothing left to return — every leg and the fee are back already. */
  outcome: 'refund' | 'already-refunded';
  workflowId: string;
  userId: number;
  appBlockId: string | null;
  orchestratorStatus: string;
  legs: ChargeLeg[];
  legsToRefund: ChargeLeg[];
  authorFee: FeePlan;
  refundBuzz: number;
};

export type WorkflowPlan = SkipPlan | RefundablePlan;

function planFee(fee: AuthorFeeInfo): FeePlan {
  const base = { state: fee.state, feeBuzz: fee.feeBuzz, buzzType: fee.buzzType };
  switch (fee.state) {
    case 'none':
      return { ...base, treatment: 'none', refundBuzz: 0 };
    case 'reversed':
      return { ...base, treatment: 'already-refunded', refundBuzz: 0 };
    case 'unsettled':
      return { ...base, treatment: 'reversed', refundBuzz: fee.feeBuzz };
    case 'settled':
      return { ...base, treatment: 'platform-absorbed', refundBuzz: fee.feeBuzz };
    case 'unaccrued':
      return { ...base, treatment: 'refunded', refundBuzz: fee.feeBuzz };
  }
}

function planWorkflow(inspection: Inspection): WorkflowPlan {
  if (inspection.kind === 'skip')
    return {
      outcome: 'skip',
      workflowId: inspection.workflowId,
      reason: inspection.reason,
      ...(inspection.detail ? { detail: inspection.detail } : {}),
      userId: inspection.userId,
      appBlockId: inspection.appBlockId,
    };
  const skip = (reason: SkipReason): WorkflowPlan => ({
    outcome: 'skip',
    workflowId: inspection.workflowId,
    reason,
    userId: inspection.userIds.length === 1 ? inspection.userIds[0] : null,
    appBlockId: inspection.appBlockId,
  });
  if (inspection.userIds.length !== 1) return skip('mixed-users');
  if (!TERMINAL_STATUSES.has(inspection.orchestratorStatus)) return skip('not-terminal');
  if (inspection.orchestratorStatus !== REFUNDABLE_STATUS) return skip('not-succeeded');
  if (inspection.unsupportedLegs > 0) return skip('unsupported-charge');
  if (inspection.partiallyCreditedColours.length > 0) return skip('orchestrator-partial-refund');
  // No debit on the orchestrator's record, yet the platform recorded a paid spend or charged a fee:
  // the record we would refund from is missing something. Never refund the fee alone on that.
  if (
    inspection.legs.length === 0 &&
    (inspection.recordedPaidSpend || inspection.authorFee.state !== 'none')
  )
    return skip('charges-unreadable');
  if (inspection.legs.length === 0) return skip('no-charges');

  const legsToRefund = inspection.legs.filter((leg) => leg.refundedBy === null);
  const authorFee = planFee(inspection.authorFee);
  const refundBuzz = legsToRefund.reduce((sum, leg) => sum + leg.amount, 0) + authorFee.refundBuzz;
  return {
    outcome: refundBuzz > 0 ? 'refund' : 'already-refunded',
    workflowId: inspection.workflowId,
    userId: inspection.userIds[0],
    appBlockId: inspection.appBlockId,
    orchestratorStatus: inspection.orchestratorStatus,
    legs: inspection.legs,
    legsToRefund,
    authorFee,
    refundBuzz,
  };
}

export async function planAppWorkflowRefunds(workflowIds: string[], now = new Date()) {
  const records = await getAppWorkflowRecords(workflowIds);
  const inspections = await inspectAll(workflowIds, records, now);
  const plans = inspections.map(planWorkflow);
  const byColour: Record<string, number> = {};
  for (const plan of plans) {
    if (plan.outcome !== 'refund') continue;
    for (const leg of plan.legsToRefund)
      byColour[leg.buzzType] = (byColour[leg.buzzType] ?? 0) + leg.amount;
    if (plan.authorFee.refundBuzz > 0 && plan.authorFee.buzzType)
      byColour[plan.authorFee.buzzType] =
        (byColour[plan.authorFee.buzzType] ?? 0) + plan.authorFee.refundBuzz;
  }
  const totalBuzz = Object.values(byColour).reduce((sum, n) => sum + n, 0);
  return { plans, byColour, totalBuzz };
}

export type AppWorkflowRefundPlan = Awaited<ReturnType<typeof planAppWorkflowRefunds>>;

/**
 * Refuses a feedback link that does not describe these refunds: a report that is not App feedback,
 * that another user filed, or that names a different app. Runs on the plan, before any money moves.
 */
export async function assertFeedbackMatchesPlan(feedbackId: number, plan: AppWorkflowRefundPlan) {
  const feedback = await getAppFeedbackForRefund(feedbackId);
  if (!feedback)
    throw new TRPCError({ code: 'NOT_FOUND', message: `Feedback ${feedbackId} not found` });
  if (feedback.area !== APP_BLOCK_FEEDBACK_AREA)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Feedback ${feedbackId} is not App feedback (area "${feedback.area}")`,
    });
  for (const p of plan.plans) {
    if (p.userId !== null && p.userId !== feedback.userId)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Workflow ${p.workflowId} belongs to user ${p.userId}, not to the user who filed feedback ${feedbackId}`,
      });
    if (feedback.appBlockId && p.appBlockId && p.appBlockId !== feedback.appBlockId)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Workflow ${p.workflowId} ran in a different app than the one feedback ${feedbackId} is about`,
      });
  }
  return feedback;
}

export type LegResult = {
  transactionId: string;
  amount: number;
  buzzType: string;
  status: 'would-refund' | 'refunded' | 'already-refunded' | 'failed';
  refundTransactionId: string | null;
  error?: string;
};

export type WorkflowRefundResult = {
  workflowId: string;
  userId: number | null;
  app: { id: string; name: string | null } | null;
  outcome: 'would-refund' | 'refunded' | 'already-refunded' | 'failed' | 'skipped';
  reason?: SkipReason;
  detail?: string;
  orchestratorStatus?: string;
  legs: LegResult[];
  authorFee?: {
    state: AuthorFeeState;
    treatment: AuthorFeeTreatment;
    feeBuzz: number;
    buzzType: string | null;
    status: 'would-apply' | 'done' | 'failed' | 'not-applicable';
    error?: string;
  };
  /** Buzz this call returned (execute) or would return (dry run). */
  refundBuzz: number;
  /** `refundBuzz` by colour. On execute, only what THIS call created. */
  byColour: Record<string, number>;
  errors: string[];
};

function plannedByColour(plan: RefundablePlan) {
  const byColour: Record<string, number> = {};
  for (const leg of plan.legsToRefund)
    byColour[leg.buzzType] = (byColour[leg.buzzType] ?? 0) + leg.amount;
  if (plan.authorFee.refundBuzz > 0 && plan.authorFee.buzzType)
    byColour[plan.authorFee.buzzType] =
      (byColour[plan.authorFee.buzzType] ?? 0) + plan.authorFee.refundBuzz;
  return byColour;
}

function legResults(plan: RefundablePlan) {
  return plan.legs.map<LegResult>((leg) => ({
    transactionId: leg.transactionId,
    amount: leg.amount,
    buzzType: leg.buzzType,
    status: leg.refundedBy ? 'already-refunded' : 'would-refund',
    refundTransactionId: leg.refundTransactionId,
  }));
}

/**
 * Returns the author fee in the treatment the plan chose. `created` is false when the fee turned out
 * to be back with the user already — this call returned nothing, and must not count it.
 *
 * The author is never clawed back: a fee whose accrual day is still open is reversed (the accrual row
 * goes, so it is never paid out); one whose day has closed may already be the author's, so the user is
 * refunded it and the platform absorbs it.
 */
async function applyFee(
  workflowId: string,
  userId: number,
  fee: FeePlan,
  details: Record<string, unknown>
): Promise<{ treatment: AuthorFeeTreatment; created: boolean; error: string | null }> {
  const already = { treatment: 'already-refunded' as const, created: false, error: null };
  // Re-read right before acting: another call may have returned it since the plan was made.
  if (await getTransactionByExternalId(blockAuthorFeeReversalKey(workflowId))) return already;

  const giveBack = async (treatment: AuthorFeeTreatment) => {
    const landed = await refundBlockAuthorFee({
      workflowId,
      viewerUserId: userId,
      buzzType: fee.buzzType as BuzzAccountType,
      feeBuzz: fee.feeBuzz,
      details,
    });
    if (landed === 'existed') return already;
    return landed
      ? { treatment, created: true, error: null }
      : { treatment, created: false, error: 'author fee refund did not land' };
  };

  if (fee.treatment === 'platform-absorbed' || fee.treatment === 'refunded')
    return giveBack(fee.treatment);
  if (fee.treatment !== 'reversed')
    return { treatment: fee.treatment, created: false, error: null };

  const reversal = await reverseBlockAuthorFee({
    workflowId,
    terminalStatus: 'moderator-refund',
    refundDetails: details,
  });
  if (reversal.reversed) return { treatment: 'reversed', created: true, error: null };
  // The accrual day closed between the plan and now: the author may be paid it, so it is absorbed.
  if (reversal.reason === 'settlement-eligible' || reversal.reason === 'already-settled')
    return giveBack('platform-absorbed');
  // Another reverser claimed the row first. Done only if its refund is on the ledger.
  if (reversal.reason === 'no-accrual') {
    const onLedger = await getTransactionByExternalId(blockAuthorFeeReversalKey(workflowId));
    return onLedger
      ? already
      : {
          treatment: 'reversed',
          created: false,
          error: 'author fee reversal is in progress elsewhere; re-run',
        };
  }
  // `refund-failed`: the accrual row is gone and the refund did not land. A re-run reads the fee
  // as `unaccrued` and returns it under the same key.
  return {
    treatment: 'reversed',
    created: false,
    error: 'author fee reversal did not land; re-run to retry',
  };
}

async function executeWorkflow(plan: RefundablePlan, actorDetails: Record<string, unknown>) {
  const legs = legResults(plan);
  const errors: string[] = [];
  let refundBuzz = 0;
  const byColour: Record<string, number> = {};
  const add = (colour: string | null, amount: number) => {
    refundBuzz += amount;
    if (colour) byColour[colour] = (byColour[colour] ?? 0) + amount;
  };
  for (const leg of legs) {
    if (leg.status !== 'would-refund') continue;
    try {
      // Buzz may answer a repeat 200, so `created` alone would count a refund another call made.
      // The ledger read first stops that only because this runs under the workflow's execute
      // lock: no other execute of this workflow can land a refund between the read and the call.
      const { created } = await refundTransactionOnce(
        leg.transactionId,
        APP_REFUND_DESCRIPTION,
        { workflowId: plan.workflowId, ...actorDetails },
        { readLedgerFirst: true }
      );
      leg.refundTransactionId = `refund-${leg.transactionId}`;
      if (created) {
        leg.status = 'refunded';
        add(leg.buzzType, leg.amount);
      } else leg.status = 'already-refunded';
    } catch (error) {
      leg.status = 'failed';
      leg.error = errorMessage(error);
      errors.push(`leg ${leg.transactionId}: ${leg.error}`);
    }
  }

  let feeStatus: 'done' | 'failed' | 'not-applicable' = 'not-applicable';
  let feeTreatment = plan.authorFee.treatment;
  let feeError: string | undefined;
  if (plan.authorFee.refundBuzz > 0) {
    try {
      const applied = await applyFee(plan.workflowId, plan.userId, plan.authorFee, {
        workflowId: plan.workflowId,
        ...actorDetails,
      });
      feeTreatment = applied.treatment;
      if (applied.error) {
        feeStatus = 'failed';
        feeError = applied.error;
      } else {
        feeStatus = 'done';
        if (applied.created) add(plan.authorFee.buzzType, plan.authorFee.refundBuzz);
      }
    } catch (error) {
      feeStatus = 'failed';
      feeError = errorMessage(error);
    }
    if (feeError) errors.push(`author fee: ${feeError}`);
  }

  return {
    legs,
    errors,
    refundBuzz,
    byColour,
    authorFee: {
      state: plan.authorFee.state,
      treatment: feeTreatment,
      feeBuzz: plan.authorFee.feeBuzz,
      buzzType: plan.authorFee.buzzType,
      status: feeStatus,
      ...(feeError ? { error: feeError } : {}),
    },
  };
}

/**
 * One execute of a workflow at a time, across processes. Without it two overlapping calls both read
 * "not refunded" before either refund lands, Buzz answers the repeat 200, and both count, note and
 * notify the same leg (the fee's read-then-act has the same shape). A caller that waits out the
 * holder re-reads the ledger inside the lock and reports what the holder did as `already-refunded`.
 *
 * TTL 30s, renewed while the holder lives, as the other Buzz-moving locks are: a workflow is a few
 * Buzz calls, and a dead holder's lock still expires. A waiter gives up after ~5s.
 */
const EXECUTE_LOCK = { ttl: 30, autoRenew: true, retryDelay: 250, maxRetries: 20 } as const;
export const appWorkflowRefundLockKey = (workflowId: string) => `app-workflow-refund:${workflowId}`;
export const APP_REFUND_LOCK_UNAVAILABLE =
  'another refund of this workflow is in progress, or its lock could not be taken; nothing was refunded, re-run';

/** The lock was not taken, so nothing was attempted: every item still owed is reported failed. */
function notAttempted(
  plan: RefundablePlan,
  error: string
): Awaited<ReturnType<typeof executeWorkflow>> {
  const feeDue = plan.authorFee.refundBuzz > 0;
  return {
    legs: legResults(plan).map<LegResult>((leg) =>
      leg.status === 'would-refund' ? { ...leg, status: 'failed', error } : leg
    ),
    errors: [error],
    refundBuzz: 0,
    byColour: {},
    authorFee: {
      state: plan.authorFee.state,
      treatment: plan.authorFee.treatment,
      feeBuzz: plan.authorFee.feeBuzz,
      buzzType: plan.authorFee.buzzType,
      status: feeDue ? 'failed' : 'not-applicable',
      ...(feeDue ? { error } : {}),
    },
  };
}

function notificationKey(userId: number, refundIds: string[]) {
  const digest = createHash('sha256')
    .update([...refundIds].sort().join(','))
    .digest('hex');
  return `${APP_BUZZ_REFUND_TYPE}:${userId}:${digest.slice(0, 24)}`;
}

async function notifyRefundedUsers(results: WorkflowRefundResult[]) {
  const byUser = new Map<number, WorkflowRefundResult[]>();
  for (const result of results) {
    if (result.userId === null || result.refundBuzz <= 0) continue;
    byUser.set(result.userId, [...(byUser.get(result.userId) ?? []), result]);
  }
  const notified: number[] = [];
  const { createNotification } = await import('~/server/services/notification.service');
  for (const [userId, rows] of byUser) {
    const apps = new Map(rows.filter((r) => r.app).map((r) => [r.app!.id, r.app!.name]));
    const details: AppBuzzRefundDetails = {
      amount: rows.reduce((sum, r) => sum + r.refundBuzz, 0),
      appName: apps.size === 1 ? [...apps.values()][0] ?? null : null,
      appCount: apps.size,
    };
    const refundIds = rows.flatMap((r) => [
      r.workflowId,
      ...r.legs.filter((l) => l.status === 'refunded').map((l) => l.transactionId),
    ]);
    await createNotification({
      userId,
      category: appBuzzRefundNotifications[APP_BUZZ_REFUND_TYPE].category,
      type: APP_BUZZ_REFUND_TYPE,
      key: notificationKey(userId, refundIds),
      details,
    });
    notified.push(userId);
  }
  return notified;
}

type FeedbackOutcome = { feedbackId: number; resolved: boolean; reason?: string };

/**
 * Writes what this call did onto the linked report. It is marked `actioned` only when EVERY requested
 * workflow ended refunded or already-refunded; otherwise its status is left as it was and the note
 * lists what was skipped or failed, and why, so whoever picks it up next sees the rest.
 *
 * Never throws: by now money may have moved, and an error here must not read as "nothing happened".
 */
async function recordOnFeedback(
  input: { moderatorId: number; reason: string; feedback?: { id: number; userId: number } },
  results: WorkflowRefundResult[],
  refundBuzz: number
): Promise<FeedbackOutcome> {
  const feedback = input.feedback!;
  const done = results.filter((r) => r.outcome === 'refunded' || r.outcome === 'already-refunded');
  const open = results.filter((r) => r.outcome !== 'refunded' && r.outcome !== 'already-refunded');
  const resolve = open.length === 0;
  const refundIds = done.flatMap((r) => [
    ...r.legs.map((l) => l.refundTransactionId),
    ...(r.authorFee && r.authorFee.treatment !== 'none'
      ? [blockAuthorFeeReversalKey(r.workflowId)]
      : []),
  ]);
  const note = [
    `[App Buzz refund] ${refundBuzz} Buzz refunded by this call; ${done.length} of ${
      results.length
    } workflow(s) settled: ${done.map((r) => r.workflowId).join(', ') || 'none'}.`,
    `Refund transactions: ${refundIds.filter(Boolean).join(', ') || 'none'}.`,
    ...(open.length > 0
      ? [
          `Not settled: ${open
            .map((r) => `${r.workflowId} (${r.reason ?? (r.errors.join('; ') || r.outcome)})`)
            .join(', ')}.`,
        ]
      : []),
    `Reason: ${input.reason}`,
  ]
    .join(' ')
    .slice(0, 4000);
  try {
    const written = await modResolveAppFeedbackWithRefund({
      moderatorId: input.moderatorId,
      feedbackId: feedback.id,
      reporterUserId: feedback.userId,
      note,
      resolve,
    });
    if (!written)
      return {
        feedbackId: feedback.id,
        resolved: false,
        reason: 'the feedback row no longer matches',
      };
    return resolve
      ? { feedbackId: feedback.id, resolved: true }
      : {
          feedbackId: feedback.id,
          resolved: false,
          reason: 'not every workflow was refunded; noted on the report',
        };
  } catch (error) {
    return { feedbackId: feedback.id, resolved: false, reason: errorMessage(error) };
  }
}

export async function refundAppWorkflows(input: {
  plan: AppWorkflowRefundPlan;
  execute: boolean;
  moderatorId: number;
  reason: string;
  /** Already checked against the plan by `assertFeedbackMatchesPlan`. */
  feedback?: { id: number; userId: number };
}) {
  const { plan, execute } = input;
  const names = await getAppNames([
    ...new Set(plan.plans.map((p) => p.appBlockId).filter((id): id is string => !!id)),
  ]);
  const appOf = (appBlockId: string | null) =>
    appBlockId ? { id: appBlockId, name: names.get(appBlockId) ?? null } : null;

  const results: WorkflowRefundResult[] = [];
  for (const p of plan.plans) {
    if (p.outcome === 'skip') {
      results.push({
        workflowId: p.workflowId,
        userId: p.userId,
        app: appOf(p.appBlockId),
        outcome: 'skipped',
        reason: p.reason,
        ...(p.detail ? { detail: p.detail } : {}),
        legs: [],
        refundBuzz: 0,
        byColour: {},
        errors: [],
      });
      continue;
    }
    const common = {
      workflowId: p.workflowId,
      userId: p.userId,
      app: appOf(p.appBlockId),
      orchestratorStatus: p.orchestratorStatus,
    };
    const feeView = (status: 'would-apply' | 'not-applicable') => ({
      state: p.authorFee.state,
      treatment: p.authorFee.treatment,
      feeBuzz: p.authorFee.feeBuzz,
      buzzType: p.authorFee.buzzType,
      status,
    });
    if (p.outcome === 'already-refunded') {
      results.push({
        ...common,
        outcome: 'already-refunded',
        legs: legResults(p),
        authorFee: feeView('not-applicable'),
        refundBuzz: 0,
        byColour: {},
        errors: [],
      });
      continue;
    }
    if (!execute) {
      results.push({
        ...common,
        outcome: 'would-refund',
        legs: legResults(p),
        authorFee: feeView(p.authorFee.refundBuzz > 0 ? 'would-apply' : 'not-applicable'),
        refundBuzz: p.refundBuzz,
        byColour: plannedByColour(p),
        errors: [],
      });
      continue;
    }
    const done =
      (await withDistributedLock(
        { key: appWorkflowRefundLockKey(p.workflowId), ...EXECUTE_LOCK },
        () => executeWorkflow(p, { moderatorRefund: true, moderatorId: input.moderatorId })
      )) ?? notAttempted(p, APP_REFUND_LOCK_UNAVAILABLE);
    results.push({
      ...common,
      // Nothing created and nothing failed: another call returned it all since the plan.
      outcome:
        done.errors.length > 0 ? 'failed' : done.refundBuzz > 0 ? 'refunded' : 'already-refunded',
      legs: done.legs,
      authorFee: done.authorFee,
      refundBuzz: done.refundBuzz,
      byColour: done.byColour,
      errors: done.errors,
    });
  }

  /** Returned by this call (execute), or what it would return (dry run). */
  const refundBuzz = results.reduce((sum, r) => sum + r.refundBuzz, 0);
  const failed = results.filter((r) => r.outcome === 'failed').length;

  let notifiedUserIds: number[] = [];
  let feedback: FeedbackOutcome | undefined;
  if (execute) {
    // After the money, and never able to undo it: a failed notification is a missing message, not a
    // failed refund.
    try {
      notifiedUserIds = await notifyRefundedUsers(results);
    } catch {
      notifiedUserIds = [];
    }
    if (input.feedback) feedback = await recordOnFeedback(input, results, refundBuzz);
  }

  return {
    execute,
    totals: {
      plannedBuzz: plan.totalBuzz,
      plannedByColour: plan.byColour,
      refundBuzz,
      workflows: results.length,
      refunded: results.filter((r) => r.outcome === 'refunded').length,
      alreadyRefunded: results.filter((r) => r.outcome === 'already-refunded').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed,
    },
    workflows: results,
    notifiedUserIds,
    ...(feedback ? { feedback } : {}),
  };
}
