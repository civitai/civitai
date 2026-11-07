import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import {
  APP_REFUND_CAP_BUZZ,
  APP_REFUND_MAX_WORKFLOWS,
  assertFeedbackMatchesPlan,
  planAppWorkflowRefunds,
  refundAppWorkflows,
} from '~/server/services/blocks/app-workflow-refund.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('apps.refundWorkflows', {
  summary:
    'Refund the Buzz App Blocks generations charged a user — every generation leg in its original colour, and the app author’s fee — when a generation was charged but not delivered.',
  returns:
    "{ execute, cap: { limitBuzz, plannedBuzz, exceeded, largeGrantHeld }, totals: { plannedBuzz, plannedByColour, refundBuzz, workflows, refunded, alreadyRefunded, skipped, failed }, workflows: [{ workflowId, userId, app, outcome: 'would-refund' | 'refunded' | 'already-refunded' | 'failed' | 'skipped', reason?, legs: [{ transactionId, amount, buzzType, status, refundTransactionId, error? }], authorFee?: { state, treatment: 'none' | 'reversed' | 'platform-absorbed' | 'refunded' | 'already-refunded', feeBuzz, buzzType, status, error? }, refundBuzz, errors }], notifiedUserIds, feedback?: { feedbackId, resolved, reason? } }",
  notes: [
    'Requires the moderator app permission `apps.buzz.refund`.',
    `More than ${APP_REFUND_CAP_BUZZ.toLocaleString(
      'en-US'
    )} Buzz in one call (all colours together, generation legs plus fees) also requires \`apps.buzz.refund.large\`. The total is computed before any money moves.`,
    'Dry run unless `execute=true`. The dry run reports exactly what execute would do, skips included.',
    'Idempotent: each leg is refunded at most once (Buzz records `refund-<transactionId>`), and the fee at most once (`block-author-fee-reversal-<workflowId>`). A repeat call refunds nothing and reports `already-refunded`.',
    'Author fee: still reversible → reversed (the author is never paid it). Already settleable → the user is refunded it and the platform absorbs it (`platform-absorbed`); the author is not clawed back.',
    'Skipped, never refunded: not an App Blocks workflow, not found on the orchestrator, more than one user on its records, still running, a charge not on the Buzz ledger, or a colour the orchestrator has already partly credited (a leg can only be refunded whole).',
    'Each refunded user is notified once per call, with a fixed sentence — the `reason` stays in the audit row (and the feedback triage note).',
    'With `feedbackId`: the report must be App feedback filed by the refunded user about the same app. On a fully successful execute it is marked `actioned` with the refund appended to its triage note.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: z.object({
    workflowIds: z
      .array(z.string().trim().min(1).max(128))
      .min(1)
      .max(APP_REFUND_MAX_WORKFLOWS)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'workflowIds must be unique' }),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(500)
      .describe('Why: an audit note for moderators. The user does not see it.'),
    feedbackId: z.coerce.number().int().positive().max(2147483647).optional(),
    execute: moderatorBoolean.default(false),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'apps.buzz.refund')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Refunding App Buzz needs the "apps.buzz.refund" moderator permission.',
      });

    // The whole decision — what is owed, the cap, the feedback link — is made on this plan, before
    // any money moves.
    const plan = await planAppWorkflowRefunds(input.workflowIds);
    const exceeded = plan.totalBuzz > APP_REFUND_CAP_BUZZ;
    const largeGrantHeld = exceeded
      ? await hasModeratorGrant(ctx.actor, 'apps.buzz.refund.large')
      : false;
    if (exceeded && input.execute && !largeGrantHeld)
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This call would refund ${plan.totalBuzz} Buzz; over ${APP_REFUND_CAP_BUZZ} needs the "apps.buzz.refund.large" moderator permission.`,
      });
    if (input.feedbackId !== undefined) await assertFeedbackMatchesPlan(input.feedbackId, plan);

    const result = await refundAppWorkflows({
      plan,
      execute: input.execute,
      moderatorId: ctx.actor.id,
      reason: input.reason,
      feedbackId: input.feedbackId,
    });
    const userIds = [
      ...new Set(result.workflows.map((w) => w.userId).filter((id): id is number => id !== null)),
    ];
    return {
      ...result,
      cap: {
        limitBuzz: APP_REFUND_CAP_BUZZ,
        plannedBuzz: plan.totalBuzz,
        exceeded,
        largeGrantHeld,
      },
      affected: {
        workflowIds: input.workflowIds,
        userIds,
        ...(input.feedbackId !== undefined ? { feedbackIds: [input.feedbackId] } : {}),
      },
    };
  },
});
