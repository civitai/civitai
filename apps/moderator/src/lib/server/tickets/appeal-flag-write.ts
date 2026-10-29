import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm } from '../query';
import { resolutionReasonFields } from '../resolution-reason';
import type { FlagAppealDecision, FlagAppealRuling } from '../minor-flag-appeal-ruling';
import { APPEAL_SPLITS, isAppealSplit } from '$lib/minor-flags/appeal-split';
import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
import { classifyAppeal } from '$lib/tickets/appeals';
import { NOT_PERMITTED, loadOwnedAppeal, type AppealWriteRow } from './appeal-write';
import { addTicketNote, checkTicketTarget, type TicketActionDeps } from './panel-write';

export type FlagAppealWriteDeps = TicketActionDeps & {
  /** The viewer's grant on the model flag appeals page. */
  canAct: (user: App.Locals['user'], path: string) => boolean;
  appealOf: (id: number) => Promise<AppealWriteRow | null>;
  /** The Appeals queue's own ruling, so a ruling from a ticket records what the queue would. */
  ruleAppeal: (input: {
    modelId: number;
    decision: FlagAppealDecision;
    reason: { resolvedReason?: string; internalNotes?: string };
  }) => Promise<FlagAppealRuling>;
};

const ruling = z.object({
  appealId: int4Id,
  status: z.enum(['Approved', 'Rejected']),
  /** A split keeps one flag and lifts the other: always an Approved ruling. */
  ruling: z.string().optional(),
  ...resolutionReasonFields,
});

const NOT_FLAG =
  'That is not a model flag appeal; it is decided in its own queue — nothing was changed.';
const RESCAN =
  'The owner edited the text while the appeal was open, so the model will be scanned again.';

const PENDING_STILL = (id: number) =>
  `Appeal #${id} is still pending: the ruling decided another appeal on that model.`;

/**
 * 🔴 THE MODEL RULED ON IS THE ROW'S, AND THE APPEAL IS THE TICKET USER'S. The main app's resolver is
 * keyed by model and checks nothing about who filed the appeal, so the row is read first: filed by the
 * ticket's linked user, pending, and a model flag appeal. The model is the row's `entityId`, never the
 * form's, and the ruling is made under the flag appeals queue's own grant.
 */
export function createTicketFlagAppealActions(deps: FlagAppealWriteDeps) {
  return {
    appealResolveModelFlag: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user, MODEL_FLAGS_APPEALS_PATH))
        return fail(403, { error: NOT_PERMITTED });
      const input = parseForm(ruling, await event.request.clone().formData());
      if (typeof input === 'string') return fail(400, { error: input });
      const split = input.ruling || undefined;
      if (split !== undefined && (!isAppealSplit(split) || input.status !== 'Approved'))
        return fail(400, { error: 'Pick a decision.' });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;

      const owned = await loadOwnedAppeal(deps.appealOf, input.appealId, ok.userId);
      if (owned.refused) return owned.refused;
      const { appeal } = owned;
      if (classifyAppeal(appeal) !== 'modelFlag') return fail(409, { error: NOT_FLAG });

      const decision: FlagAppealDecision =
        split !== undefined && isAppealSplit(split)
          ? { minor: APPEAL_SPLITS[split].minor, poi: APPEAL_SPLITS[split].poi }
          : input.status === 'Rejected'
          ? 'uphold'
          : 'overturn';
      const result = await deps.ruleAppeal({
        modelId: appeal.entityId,
        decision,
        reason: { resolvedReason: input.resolvedReason, internalNotes: input.internalNotes },
      });
      if (!result.ok) return fail(400, { error: result.error });

      // The ruling is keyed by model, so it may have closed another appeal on it and left the posted one open.
      const stillPending = (await deps.appealOf(input.appealId))?.status === 'Pending';
      const res = await addTicketNote(
        deps.note,
        event,
        ok.ticketId,
        stillPending
          ? `Model flag ruling ${input.status} (decided another appeal on model ${appeal.entityId}; appeal #${input.appealId} of user ${ok.userId} is still pending)`
          : `${input.status} model flag appeal #${input.appealId} (model ${appeal.entityId}${
              split ? `, ${split}` : ''
            }) of user ${ok.userId}`
      );
      const warnings = [
        stillPending ? PENDING_STILL(input.appealId) : null,
        result.rescanQueued ? RESCAN : null,
        'warning' in res ? res.warning : null,
      ].filter((w) => w !== null);
      return {
        success: true as const,
        rescanQueued: result.rescanQueued,
        ...(warnings.length ? { warning: warnings.join(' ') } : {}),
      };
    },
  };
}
