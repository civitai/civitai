import { fail, type RequestEvent } from '@sveltejs/kit';
import type { ActionResult } from '../user-actions.service';
import { addTicketNote, checkTicketTarget, type TicketActionDeps } from './panel-write';
import { ruleTicketRestriction, type RestrictionRulingDeps } from './restriction-ruling';

/** A shared action: `requiresGrant` hands back a refusal directly, the others a promise. */
type Action = (event: RequestEvent) => unknown;

export type AccountWriteDeps = TicketActionDeps &
  RestrictionRulingDeps & {
    inner: { setBanned: Action; setMuted: Action };
    /** The `/users` page grant, checked as the User Lookup actions do. */
    canAct: (user: App.Locals['user']) => boolean;
    revokeTimedMute: (input: { userId: number; moderatorId: number }) => Promise<ActionResult>;
  };

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
 * 🔴 THE ACCOUNT ACTED ON IS THE TICKET'S, NEVER THE FORM'S. The posted `userId` must equal the user the
 * ticket links to, and a restriction must belong to that user, or a forged post would act on anyone
 * through a page whose grant says nothing about that account. Grants are not widened: each action keeps
 * the grant it needs in User Lookup.
 *
 * A failed note after the change is a `warning` on a success, never a failure.
 */
export function createTicketAccountActions(deps: AccountWriteDeps) {
  const checked = (event: RequestEvent) => checkTicketTarget(deps.linkedUser, event);
  const noted = (event: RequestEvent, ticketId: string, what: string) =>
    addTicketNote(deps.note, event, ticketId, what);

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
      return ruleTicketRestriction(deps, event, ok);
    },
  };
}
