import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  MODEL_RULES_HOLD_BATCH_MAX,
  MODEL_RULES_HOLD_DECISION_GRANTS,
  MODEL_RULES_STALE_HOLD_MESSAGE,
  decideModelRulesHold,
  decideModelRulesHoldBatch,
  isModelRulesHoldRefusal,
  resolveModelRulesHoldInput,
} from '~/server/services/text-scan/model-rules-hold-decision';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.resolveModelRulesHold', {
  summary: 'Decide a pending model-rules text-scan hold.',
  returns:
    '{ holdId, status: "Dismissed" | "Confirmed", decision, userId }; for `holds`: { decision, results: [{ holdId, ok, status?, stale?, error? }] }',
  notes: [
    'Any moderator may decide; `confirm_strike` also needs the moderator app permission `user.strike`.',
    '`confirm` takes a model that is still live down as a violation (the owner notice names no rule); a model already taken down at detection stays down and leaves the needs-review list. `confirm_strike` also strikes the owner once.',
    '`dismiss_not_subject` (the matched term is too broad for this subject) and `dismiss_allowed` (a permitted use) close the hold. A hold detected in Review (`shadow`) changes nothing on the model; a hold detected in Auto (`active`) republishes the model and records the clearance for that text.',
    'A hold keeps the semantics of the mode it was detected in, whatever the mode is now.',
    'Dismissing an Auto hold is refused with CONFLICT when the model is no longer unpublished as a violation for that text, or when the hold cannot name the versions its take-down put away (only those are republished); the hold stays pending.',
    'The ruling and its label-store records (one per matched rule) are one transaction. If an effect fails the hold stays pending and the call can be repeated; effects already done (republish, strike) are recorded on the hold and not repeated.',
    `\`holds\` rules up to ${MODEL_RULES_HOLD_BATCH_MAX} holds (never \`confirm_strike\`) in one call that counts as one rate-limit hit. Each is decided on its own against its \`textHash\`; a stale or refused hold is reported in \`results\` and does not stop the rest.`,
    'Refuses with CONFLICT when the hold is missing, not a model-rules hold, no longer Pending, replaced by a newer scan, or its text changed since `textHash` was read.',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: resolveModelRulesHoldInput,
  async handler(input, ctx) {
    const log = (
      result: { holdId: number; entityId?: number; userId?: number | null },
      outcome: 'ok' | 'stale' | 'refused' | 'error'
    ) =>
      logToAxiom({
        name: 'text-scan',
        type: 'model-rules-hold-decision',
        message: 'model rules hold decided',
        holdId: result.holdId,
        entityId: result.entityId,
        userId: result.userId,
        decision: input.decision,
        outcome,
        moderatorId: ctx.actor.id,
      }).catch(() => null);
    const actor = { id: ctx.actor.id, isModerator: ctx.actor.isModerator };

    if (input.holds) {
      const results = await decideModelRulesHoldBatch({
        holds: input.holds,
        decision: input.decision,
        note: input.note,
        actor,
        tracker: ctx.tracker,
      });
      const decided = results.flatMap((r) => (r.ok ? [r] : []));
      for (const r of results)
        log(
          r.ok ? r : { holdId: r.holdId },
          r.ok ? 'ok' : r.stale ? 'stale' : r.refused ? 'refused' : 'error'
        );
      return {
        decision: input.decision,
        results,
        affected: {
          textScanHoldIds: decided.map((r) => r.holdId),
          modelIds: decided.map((r) => r.entityId),
        },
      };
    }

    // A strike is held to the grant the moderator app puts on that action everywhere else.
    const actionGrant = MODEL_RULES_HOLD_DECISION_GRANTS[input.decision];
    if (actionGrant && !(await hasModeratorGrant(ctx.actor, actionGrant)))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This decision needs the "${actionGrant}" moderator permission.`,
      });

    if (input.holdId === undefined || input.textHash === undefined)
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Give `holdId` and `textHash`, or `holds`.',
      });

    let result: Awaited<ReturnType<typeof decideModelRulesHold>>;
    try {
      result = await decideModelRulesHold({
        holdId: input.holdId,
        textHash: input.textHash,
        decision: input.decision,
        note: input.note,
        actor,
        tracker: ctx.tracker,
      });
    } catch (error) {
      const refusal = isModelRulesHoldRefusal(error) ? error : null;
      log(
        { holdId: input.holdId },
        refusal?.message === MODEL_RULES_STALE_HOLD_MESSAGE
          ? 'stale'
          : refusal
          ? 'refused'
          : 'error'
      );
      if (!refusal)
        // Code and name only: a Prisma message can echo the arguments, which here are the held text.
        logToAxiom({
          name: 'text-scan',
          type: 'error',
          message: 'model rules hold decision failed',
          holdId: input.holdId,
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: (error as { code?: unknown } | null | undefined)?.code,
        }).catch(() => null);
      throw error;
    }
    log({ holdId: input.holdId, ...result }, 'ok');

    return {
      holdId: input.holdId,
      status: result.status,
      decision: input.decision,
      userId: result.userId,
      affected: {
        textScanHoldIds: [input.holdId],
        modelIds: [result.entityId],
        ...(result.userId && input.decision === 'confirm_strike'
          ? { userIds: [result.userId] }
          : {}),
      },
    };
  },
});
