import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { WriteResult } from '../freshdesk-write.service';
import { int4Id, parseForm } from '../query';

export const NOT_PERMITTED = 'Not permitted.';

export type LinkedUser =
  | { status: 'ok'; userId: number | null }
  | { status: 'refused'; code: number; message: string };

/** What every ticket panel action needs, whatever the panel. */
export type TicketActionDeps = {
  /** The Civitai user the ticket is linked to, after checking the ticket is one this page may act on. */
  linkedUser: (ticketId: string) => Promise<LinkedUser>;
  note: (ticketId: string, text: string) => Promise<WriteResult>;
};

const target = z.object({ ticketId: z.string().regex(/^\d+$/, 'No such ticket.'), userId: int4Id });

/**
 * The ticket and user a ticket action was posted for, once the user is confirmed to be the one the
 * ticket links to. Shared by every action a ticket panel offers.
 */
export async function checkTicketTarget(
  linkedUser: TicketActionDeps['linkedUser'],
  event: RequestEvent
) {
  const form = await event.request.clone().formData();
  const ids = parseForm(target, form);
  if (typeof ids === 'string') return { refused: fail(400, { error: ids }) };
  const linked = await linkedUser(ids.ticketId);
  if (linked.status === 'refused') return { refused: fail(linked.code, { error: linked.message }) };
  if (linked.userId === null || linked.userId !== ids.userId)
    return {
      refused: fail(409, {
        error: 'That account is not the one linked to this ticket — nothing was changed.',
      }),
    };
  return { ticketId: ids.ticketId, userId: ids.userId, form };
}

/**
 * The private note naming the moderator, left after a change. A failed note is a `warning` on a
 * success, never a failure: the change is already made.
 */
export async function addTicketNote(
  note: TicketActionDeps['note'],
  event: RequestEvent,
  ticketId: string,
  what: string
) {
  const { id, username } = event.locals.user;
  const text = `${what} by ${username ?? 'unknown'} (user ${id}) from the moderator app.`;
  let res: WriteResult;
  try {
    res = await note(ticketId, text);
  } catch (e) {
    res = {
      status: 'error',
      httpStatus: null,
      certain: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (res.status === 'ok') return { success: true as const };
  const why = res.status === 'error' ? res.message : 'the Freshdesk write key is not configured';
  return {
    success: true as const,
    warning: `The change was made, but the note on the ticket failed: ${why}`,
  };
}
