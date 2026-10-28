import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import type { WriteResult } from '../freshdesk-write.service';
import { int4Id, parseForm } from '../query';
import { checkedResolutionReason, resolutionReasonFields } from '../resolution-reason';
import type { ActionResult } from '../user-actions.service';
import { unwiredRulingReason } from '$lib/restriction-types';

/** A shared action: `requiresGrant` hands back a refusal directly, the others a promise. */
type Action = (event: RequestEvent) => unknown;

export type LinkedUser =
  | { status: 'ok'; userId: number | null }
  | { status: 'refused'; code: number; message: string };

export type AccountWriteDeps = {
  /** The Civitai user the ticket is linked to, after checking the ticket is one this page may act on. */
  linkedUser: (ticketId: string) => Promise<LinkedUser>;
  /** The shared enforcement actions; each keeps its own grant check. */
  inner: { setBanned: Action; setMuted: Action };
  /** The `/users` page grant, which the actions below gate on exactly as User Lookup does. */
  canAct: (user: App.Locals['user']) => boolean;
  revokeTimedMute: (input: { userId: number; moderatorId: number }) => Promise<ActionResult>;
  resolveRestriction: (input: {
    userRestrictionId: number;
    status: 'Overturned' | 'Upheld';
    resolvedReason: string;
    internalNotes?: string;
    userId: number;
    moderatorId: number;
  }) => Promise<ActionResult>;
  restrictionOf: (id: number) => Promise<{ userId: number; type: string; status: string } | null>;
  /** A private note on the ticket, as plain text. */
  note: (ticketId: string, text: string) => Promise<WriteResult>;
};

const target = z.object({ ticketId: z.string().regex(/^\d+$/, 'No such ticket.'), userId: int4Id });

const rulingSchema = z.object({
  userRestrictionId: int4Id,
  status: z.enum(['Overturned', 'Upheld']),
  ...resolutionReasonFields,
});

const NOT_PERMITTED = 'Not permitted.';

/** A form carrying exactly these fields, so a forged extra one never reaches a shared action. */
const innerEvent = (event: RequestEvent, fields: Record<string, string>): RequestEvent => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return { ...event, request: new Request(event.request.url, { method: 'POST', body: form }) };
};

const succeeded = (result: unknown): boolean =>
  typeof result === 'object' &&
  result !== null &&
  (result as { success?: unknown }).success === true;

/**
 * Lifting a ban, a mute or a restriction from a ticket: the account actions of User Lookup, reached through
 * the ticket that links the account.
 *
 * 🔴 THE ACCOUNT ACTED ON IS THE TICKET'S, NEVER THE FORM'S. The posted `userId` must equal the user the
 * ticket links to, and a restriction must belong to that user, or a forged post would act on anyone
 * through a page whose grant says nothing about that account. Grants are not widened: each action keeps
 * the grant it needs in User Lookup.
 *
 * After the change a private note names the moderator. The change has already happened by then, so a
 * failed note is a `warning` on a success, never a failure.
 */
export function createTicketAccountActions(deps: AccountWriteDeps) {
  async function checked(event: RequestEvent) {
    const form = await event.request.clone().formData();
    const ids = parseForm(target, form);
    if (typeof ids === 'string') return { refused: fail(400, { error: ids }) };
    const linked = await deps.linkedUser(ids.ticketId);
    if (linked.status === 'refused')
      return { refused: fail(linked.code, { error: linked.message }) };
    if (linked.userId === null || linked.userId !== ids.userId)
      return {
        refused: fail(409, {
          error: 'That account is not the one linked to this ticket — nothing was changed.',
        }),
      };
    return { ticketId: ids.ticketId, userId: ids.userId, form };
  }

  async function noted(event: RequestEvent, ticketId: string, what: string) {
    const { id, username } = event.locals.user;
    const text = `${what} by ${username ?? 'unknown'} (user ${id}) from the moderator app.`;
    let res: WriteResult;
    try {
      res = await deps.note(ticketId, text);
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

  /** Runs a shared action and, only when it succeeded, adds the note. */
  async function viaInner(
    event: RequestEvent,
    action: Action,
    fields: Record<string, string>,
    what: string
  ) {
    const ok = await checked(event);
    if (ok.refused) return ok.refused;
    const result: unknown = await action(
      innerEvent(event, { userId: String(ok.userId), ...fields })
    );
    if (!succeeded(result)) return result;
    return noted(event, ok.ticketId, `${what} user ${ok.userId}`);
  }

  return {
    accountUnban: (event: RequestEvent) =>
      viaInner(event, deps.inner.setBanned, { ban: 'false' }, 'Unbanned'),

    accountUnmute: (event: RequestEvent) =>
      viaInner(event, deps.inner.setMuted, { muted: 'false' }, 'Unmuted'),

    accountLiftTimedMute: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user)) return fail(403, { error: NOT_PERMITTED });
      const ok = await checked(event);
      if (ok.refused) return ok.refused;
      const result = await deps.revokeTimedMute({
        userId: ok.userId,
        moderatorId: event.locals.user.id,
      });
      if (!result.ok) return fail(400, { error: result.error });
      return noted(event, ok.ticketId, `Lifted the timed mute on user ${ok.userId}`);
    },

    accountResolveRestriction: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user)) return fail(403, { error: NOT_PERMITTED });
      const ok = await checked(event);
      if (ok.refused) return ok.refused;
      const input = parseForm(rulingSchema, ok.form);
      if (typeof input === 'string') return fail(400, { error: input });
      const reason = checkedResolutionReason('restriction', input.status, input);
      if (typeof reason === 'string') return fail(400, { error: reason });

      const row = await deps.restrictionOf(input.userRestrictionId);
      if (!row) return fail(404, { error: 'Restriction not found.' });
      if (row.userId !== ok.userId)
        return fail(409, {
          error: 'That restriction belongs to another account — nothing was changed.',
        });
      if (row.status !== 'Pending')
        return fail(409, { error: 'That restriction has already been ruled on.' });
      const unwired = unwiredRulingReason(row.type);
      if (unwired) return fail(400, { error: unwired });

      const result = await deps.resolveRestriction({
        userRestrictionId: input.userRestrictionId,
        status: input.status,
        ...reason,
        userId: ok.userId,
        moderatorId: event.locals.user.id,
      });
      if (!result.ok) return fail(400, { error: result.error });
      return noted(
        event,
        ok.ticketId,
        `${input.status} restriction #${input.userRestrictionId} (${row.type}) of user ${ok.userId}`
      );
    },
  };
}
