import { TRPCError } from '@trpc/server';
import { logToAxiom } from '~/server/logging/client';
import { hasModeratorGrant } from '~/server/services/moderator-grants';
import {
  CSAM_HOLD_BATCH_MAX,
  CSAM_HOLD_DECISION_GRANTS,
  decideCsamHold,
  decideCsamHoldBatch,
  resolveCsamHoldInput,
} from '~/server/services/text-scan/csam-hold-decision';
import { resolveClientIpOrNull } from '~/server/utils/client-ip';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('textScan.resolveCsamHold', {
  summary: 'Decide a pending csam text-scan hold.',
  returns:
    '{ holdId, status: "Dismissed" | "Confirmed", decision, userId }; for `holds`: { decision, results: [{ holdId, ok, status?, stale?, error? }] }',
  notes: [
    'Requires the moderator app permission `csam.report.file`; `remove_strike` also needs `user.strike`, and `remove_ban` and `remove_ban_report` also need `user.ban`.',
    '`dismiss` closes the hold and changes nothing on the held content or its author.',
    '`remove` takes the held content down through the same service a moderator removal uses; `remove_strike` also strikes the author; `remove_ban` and `remove_ban_report` also ban the author (skipped when already banned).',
    '`remove_ban_report` does not file anything: the moderator completes the existing CSAM report form for the returned `userId`. No Report row is created by any decision.',
    'A removal decision is refused with BAD_REQUEST for a type with no removal path; the hold stays pending.',
    'The decision and its label-store record are one transaction. If a removal, strike or ban fails the hold stays pending and the call can be repeated.',
    `\`holds\` decides up to ${CSAM_HOLD_BATCH_MAX} holds (\`remove\` or \`dismiss\` only) in one call that counts as one rate-limit hit. Each is decided on its own against its \`textHash\`; a stale or refused hold is reported in \`results\` and does not stop the rest.`,
    'Refuses with CONFLICT when the hold is missing, not a csam hold, no longer Pending, or its text changed since `textHash` was read (when given) (a rescan of edited content updates the pending hold in place).',
  ],
  rateLimit: { max: 60, windowSeconds: 60 },
  input: resolveCsamHoldInput,
  async handler(input, ctx) {
    if (!(await hasModeratorGrant(ctx.actor, 'csam.report.file')))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Deciding a csam hold needs the "csam.report.file" moderator permission.',
      });

    if (input.holds) {
      const results = await decideCsamHoldBatch({
        holds: input.holds,
        decision: input.decision,
        note: input.note,
        actor: { id: ctx.actor.id, ip: resolveClientIpOrNull(ctx.req) ?? undefined },
        tracker: ctx.tracker,
      });
      const decided = results.flatMap((r) => (r.ok ? [r] : []));
      for (const r of results) {
        logToAxiom({
          name: 'text-scan',
          type: 'csam-hold-decision',
          message: 'csam hold decided',
          holdId: r.holdId,
          entityType: r.ok ? r.entityType : undefined,
          entityId: r.ok ? r.entityId : undefined,
          userId: r.ok ? r.userId : undefined,
          decision: input.decision,
          outcome: r.ok ? 'ok' : r.stale ? 'stale' : 'error',
          moderatorId: ctx.actor.id,
        }).catch(() => null);
      }
      return {
        decision: input.decision,
        results,
        affected: {
          textScanHoldIds: decided.map((r) => r.holdId),
          ...(input.decision !== 'dismiss'
            ? { userIds: [...new Set(decided.flatMap((r) => (r.userId ? [r.userId] : [])))] }
            : {}),
        },
      };
    }

    // A strike or ban is held to the grant the moderator app puts on those actions everywhere else.
    const actionGrant = CSAM_HOLD_DECISION_GRANTS[input.decision];
    if (actionGrant && !(await hasModeratorGrant(ctx.actor, actionGrant)))
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `This decision needs the "${actionGrant}" moderator permission.`,
      });

    if (input.holdId === undefined)
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Give `holdId` or `holds`.' });

    // Audit surface only (it feeds the reward pipeline's idempotency key, never an access check).
    const ip = resolveClientIpOrNull(ctx.req) ?? undefined;
    const result = await decideCsamHold({
      holdId: input.holdId,
      textHash: input.textHash,
      decision: input.decision,
      note: input.note,
      actor: { id: ctx.actor.id, ip },
      tracker: ctx.tracker,
    });

    logToAxiom({
      name: 'text-scan',
      type: 'csam-hold-decision',
      message: 'csam hold decided',
      holdId: input.holdId,
      entityType: result.entityType,
      entityId: result.entityId,
      userId: result.userId,
      decision: input.decision,
      outcome: 'ok',
      moderatorId: ctx.actor.id,
    }).catch(() => null);

    return {
      holdId: input.holdId,
      status: result.status,
      decision: input.decision,
      userId: result.userId,
      affected: {
        textScanHoldIds: [input.holdId],
        ...(result.userId && input.decision !== 'dismiss' ? { userIds: [result.userId] } : {}),
      },
    };
  },
});
