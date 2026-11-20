import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { userId } from '~/server/schema/moderator/user';
import { resolveListingAppBlockId } from '~/server/services/blocks/app-workflow-refund.data';
import {
  lookupAppWorkflowCharges,
  resolveChargesWindow,
  WORKFLOW_CHARGES_DEFAULT_DAYS,
  WORKFLOW_CHARGES_MAX_DAYS,
} from '~/server/services/blocks/app-workflow-refund.service';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('apps.workflowCharges', {
  summary:
    "List one account's App Blocks generations and what each charged: the Buzz legs, the app author's fee, and what has been refunded.",
  returns:
    '{ userId, from, to, workflows: [{ workflowId, app: { id, name } | null, submittedAt, recordedStatus, orchestratorStatus, charges: [{ transactionId, amount, buzzType, refundedBy, refundTransactionId }], authorFee: { state, feeBuzz, buzzType, accruedAt, refundTransactionId }, refundState, refundTransactionIds, refundBlocker } | { workflowId, app, submittedAt, recordedStatus, orchestratorStatus: null, refundBlocker, lookupError? }] }',
  notes: [
    'Requires the moderator app permission `apps.buzz.refund`. Read-only.',
    `Window \`[from, to)\`: defaults to the last ${WORKFLOW_CHARGES_DEFAULT_DAYS} days, at most ${WORKFLOW_CHARGES_MAX_DAYS}.`,
    'Filter by `appBlockId` or by `listing` (a listing id or slug), not both.',
    '`recordedStatus` is our own record of the workflow; `orchestratorStatus` is read from the orchestrator, which is also where the charge legs come from.',
    '`authorFee.state`: `unsettled` can still be reversed; `settled` may already be paid to the author (a refund then comes from the platform); `unaccrued` was charged with no accrual; `reversed` is back with the user.',
    '`refundBlocker` is the reason `/api/mod/apps/refund-workflows` would skip the workflow (its own planner decides it), or null.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({
    userId,
    appBlockId: z.string().trim().min(1).max(64).optional(),
    listing: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('An App listing id or slug, instead of appBlockId.'),
    from: z.coerce.date().optional().describe('Inclusive. ISO-8601.'),
    to: z.coerce.date().optional().describe('Exclusive. ISO-8601; defaults to now.'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'apps.buzz.refund')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Looking up App Buzz spend needs the "apps.buzz.refund" moderator permission.',
      });
    if (input.appBlockId && input.listing)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Give appBlockId or listing, not both' });

    const range = resolveChargesWindow(input, new Date());
    let appBlockId = input.appBlockId;
    if (input.listing) {
      const resolved = await resolveListingAppBlockId(input.listing);
      if (!resolved)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `No App listing hosting a block matches "${input.listing}"`,
        });
      appBlockId = resolved;
    }

    const result = await lookupAppWorkflowCharges({
      userId: input.userId,
      appBlockId,
      from: range.from,
      to: range.to,
      limit: input.limit,
    });
    return { ...result, affected: { userIds: [input.userId] } };
  },
});
