import { fail, type RequestEvent } from '@sveltejs/kit';
import { parseRestrictionRuling, rulingReason } from '../restriction-ruling';
import type { ActionResult } from '../user-actions.service';
import { unwiredRulingReason } from '$lib/restriction-types';
import { addTicketNote, type TicketActionDeps } from './panel-write';

export type RestrictionRulingDeps = Pick<TicketActionDeps, 'note'> & {
  resolveRestriction: (input: {
    userRestrictionId: number;
    status: 'Overturned' | 'Upheld';
    resolvedReason: string;
    internalNotes?: string;
    userId: number;
    moderatorId: number;
  }) => Promise<ActionResult>;
  restrictionOf: (id: number) => Promise<{ userId: number; type: string; status: string } | null>;
};

/**
 * Rules on one Pending restriction of the ticket's user, after the caller has checked its own page grant
 * and the ticket target (`checkTicketTarget`). Shared by every ticket card that offers a ruling, so the
 * row checks cannot drift apart: the restriction is read by id and must belong to the ticket's user and be
 * open, and the ruling is made with the row's ids, never the form's. `types` limits it to the types the
 * calling page's own queue holds; a row of another type is not found, as that queue answers.
 *
 * A failed note after the ruling is a `warning` on a success, never a failure.
 */
export async function ruleTicketRestriction(
  deps: RestrictionRulingDeps,
  event: RequestEvent,
  target: { ticketId: string; userId: number; form: FormData },
  types?: readonly string[]
) {
  const parsed = parseRestrictionRuling(target.form);
  if (!parsed.ok) return fail(400, { error: parsed.error });
  const { input } = parsed;

  const row = await deps.restrictionOf(input.userRestrictionId);
  if (!row || (types && !types.includes(row.type)))
    return fail(404, { error: 'Restriction not found.' });
  if (row.userId !== target.userId)
    return fail(409, {
      error: 'That restriction belongs to another account — nothing was changed.',
    });
  if (row.status !== 'Pending')
    return fail(409, { error: 'That restriction has already been ruled on.' });
  const unwired = unwiredRulingReason(row.type);
  if (unwired) return fail(400, { error: unwired });
  const reason = rulingReason(input);
  if (!reason.ok) return fail(400, { error: reason.error });

  const result = await deps.resolveRestriction({
    userRestrictionId: input.userRestrictionId,
    status: input.status,
    resolvedReason: reason.resolvedReason,
    internalNotes: reason.internalNotes,
    userId: target.userId,
    moderatorId: event.locals.user.id,
  });
  if (!result.ok) return fail(400, { error: result.error });
  return addTicketNote(
    deps.note,
    event,
    target.ticketId,
    `${input.status} restriction #${input.userRestrictionId} (${row.type}) of user ${target.userId}`
  );
}
