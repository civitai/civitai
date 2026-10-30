import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm } from '../query';
import { checkedResolutionReason, resolutionReasonFields } from '../resolution-reason';
import type { RemovedAppealDecision } from '../removed-appeals.service';
import type { SiteAppealResolution } from '../site-appeals.service';
import { REMOVED_APPEALS_PATH, appealQueuePath, classifyAppeal } from '$lib/tickets/appeals';
import { SITE_APPEAL_QUEUES } from '$lib/site-appeals';
import type { SiteAppealCategory } from '@civitai/shared/site-appeal';
import { DECIDED, loadOwnedAppeal, type AppealWriteRow } from './appeal-write';
import {
  NOT_PERMITTED,
  addTicketNote,
  checkTicketTarget,
  type TicketActionDeps,
} from './panel-write';

export type QueueAppealWriteDeps = TicketActionDeps & {
  /** Reads the ticket as an account ticket: the Account card is where an Account appeal is decided. */
  accountLinkedUser: TicketActionDeps['linkedUser'];
  /** The viewer's grant on a queue page. */
  canAct: (user: App.Locals['user'], path: string) => boolean;
  appealOf: (id: number) => Promise<AppealWriteRow | null>;
  /** The removed-appeals queue's own form rules, so a ruling from a ticket records what the queue would. */
  parseRemoved: (form: FormData) =>
    | {
        status: 'Approved' | 'Rejected';
        resolvedReason: string;
        internalNotes: string | undefined;
        resolvedMessage: string | undefined;
      }
    | string;
  resolveRemoved: (input: {
    appealId: number;
    decision: RemovedAppealDecision;
    resolvedReason?: string;
    internalNotes?: string;
    resolvedMessage?: string;
    moderatorId: number;
  }) => Promise<{ refunded: boolean; refundFailed: boolean } | null>;
  resolveSite: (input: {
    appealId: number;
    category: SiteAppealCategory;
    decision: 'Approved' | 'Rejected';
    resolvedReason: string;
    internalNotes?: string;
    resolvedMessage?: string;
    moderatorId: number;
    canBan: boolean;
  }) => Promise<SiteAppealResolution>;
};

const appealId = z.object({ appealId: int4Id });
const siteRuling = z.object({
  appealId: int4Id,
  status: z.enum(['Approved', 'Rejected']),
  resolvedMessage: z.string().trim().max(1000).optional(),
  ...resolutionReasonFields,
});

const NOT_REMOVED =
  'That is not a removed-content appeal; it is decided in its own queue — nothing was changed.';
const REFUND_FAILED =
  'The appeal was decided, but the fee refund failed. Refund it from the removed-appeals queue.';

/**
 * 🔴 EVERY RULING HERE DECIDES THE TICKET USER'S OWN PENDING APPEAL OF ONE KIND. The services key by
 * appeal id and check nothing about who filed it, so the row is read first: filed by the ticket's linked
 * user, pending, and of the kind this action decides. Each is ruled under the grant of the queue it
 * would otherwise be decided in, and with the row's category and ids, never the form's.
 */
export function createTicketQueueAppealActions(deps: QueueAppealWriteDeps) {
  const removedAppeal = async (event: RequestEvent) => {
    if (!deps.canAct(event.locals.user, REMOVED_APPEALS_PATH))
      return { refused: fail(403, { error: NOT_PERMITTED }) };
    const input = parseForm(appealId, await event.request.clone().formData());
    if (typeof input === 'string') return { refused: fail(400, { error: input }) };
    const ok = await checkTicketTarget(deps.linkedUser, event);
    if (ok.refused) return { refused: ok.refused };
    const owned = await loadOwnedAppeal(deps.appealOf, input.appealId, ok.userId);
    if (owned.refused) return { refused: owned.refused };
    if (classifyAppeal(owned.appeal) !== 'removed')
      return { refused: fail(409, { error: NOT_REMOVED }) };
    return { ...input, ...ok, appeal: owned.appeal };
  };

  /** A site-form appeal of `account` (the Account card's) or of any other category (the Appeals card's). */
  const siteAppeal = async (event: RequestEvent, account: boolean) => {
    const queues = SITE_APPEAL_QUEUES.filter((q) => (q.category === 'Account') === account);
    if (!queues.some((q) => deps.canAct(event.locals.user, appealQueuePath('site', q.category)!)))
      return { refused: fail(403, { error: NOT_PERMITTED }) };
    const input = parseForm(siteRuling, await event.request.clone().formData());
    if (typeof input === 'string') return { refused: fail(400, { error: input }) };
    const ok = await checkTicketTarget(account ? deps.accountLinkedUser : deps.linkedUser, event);
    if (ok.refused) return { refused: ok.refused };
    const owned = await loadOwnedAppeal(deps.appealOf, input.appealId, ok.userId);
    if (owned.refused) return { refused: owned.refused };
    const { appeal } = owned;
    const category = appeal.category as SiteAppealCategory | null;
    if (classifyAppeal(appeal) !== 'site' || category === null)
      return {
        refused: fail(409, {
          error:
            'That is not a site-form appeal; it is decided in its own queue — nothing was changed.',
        }),
      };
    if ((category === 'Account') !== account)
      return {
        refused: fail(409, {
          error: account
            ? 'That is not an account appeal — nothing was changed.'
            : 'Account appeals are decided in the Account card — nothing was changed.',
        }),
      };
    if (!deps.canAct(event.locals.user, appealQueuePath('site', category)!))
      return { refused: fail(403, { error: NOT_PERMITTED }) };
    const reason = checkedResolutionReason('appeal', input.status, input);
    if (typeof reason === 'string') return { refused: fail(400, { error: reason }) };
    return { ...input, ...ok, ...reason, category };
  };

  const decideSite = async (event: RequestEvent, account: boolean) => {
    const r = await siteAppeal(event, account);
    if (r.refused) return r.refused;
    const result = await deps.resolveSite({
      appealId: r.appealId,
      category: r.category,
      decision: r.status,
      resolvedReason: r.resolvedReason,
      internalNotes: r.internalNotes,
      resolvedMessage: r.resolvedMessage || undefined,
      moderatorId: event.locals.user.id,
      canBan: event.locals.grants['user.ban'] === true,
    });
    if (!result.ok) return fail(result.conflict ? 409 : 400, { error: result.error });
    const lifted = result.lifted.length ? ` (lifted: ${result.lifted.join(', ')})` : '';
    return addTicketNote(
      deps.note,
      event,
      r.ticketId,
      `${r.status} ${r.category} appeal #${r.appealId}${lifted} of user ${r.userId}`
    );
  };

  return {
    appealResolveRemoved: async (event: RequestEvent) => {
      const r = await removedAppeal(event);
      if (r.refused) return r.refused;
      const ruling = deps.parseRemoved(r.form);
      if (typeof ruling === 'string') return fail(400, { error: ruling });
      const closed = await deps.resolveRemoved({
        appealId: r.appealId,
        decision: ruling.status,
        resolvedReason: ruling.resolvedReason,
        internalNotes: ruling.internalNotes,
        resolvedMessage: ruling.resolvedMessage,
        moderatorId: event.locals.user.id,
      });
      if (!closed) return fail(409, { error: DECIDED });
      return withRefundWarning(
        await addTicketNote(
          deps.note,
          event,
          r.ticketId,
          `${ruling.status} removed-content appeal #${r.appealId} (${r.appeal.entityType} ${r.appeal.entityId}) of user ${r.userId}`
        ),
        closed.refundFailed
      );
    },

    appealCloseRemoved: async (event: RequestEvent) => {
      const r = await removedAppeal(event);
      if (r.refused) return r.refused;
      const closed = await deps.resolveRemoved({
        appealId: r.appealId,
        decision: 'OwnerDeleted',
        moderatorId: event.locals.user.id,
      });
      if (!closed) return fail(409, { error: DECIDED });
      return withRefundWarning(
        await addTicketNote(
          deps.note,
          event,
          r.ticketId,
          `Closed removed-content appeal #${r.appealId} (${r.appeal.entityType} ${r.appeal.entityId}) of user ${r.userId} as deleted by owner`
        ),
        closed.refundFailed
      );
    },

    appealResolveSite: (event: RequestEvent) => decideSite(event, false),
    appealResolveAccount: (event: RequestEvent) => decideSite(event, true),
  };
}

/** The decision is made either way, so a failed refund rides on the success next to any note warning. */
function withRefundWarning<T extends { success: true; warning?: string }>(
  res: T,
  refundFailed: boolean
) {
  if (!refundFailed) return res;
  return {
    ...res,
    warning: res.warning ? `${REFUND_FAILED} ${res.warning}` : REFUND_FAILED,
  };
}
