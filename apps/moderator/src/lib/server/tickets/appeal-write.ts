import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id, parseForm } from '../query';
import { addTicketNote, checkTicketTarget, type AccountWriteDeps } from './account-write';

export type AppealRow = {
  userId: number;
  status: string;
  entityType: string;
  entityId: number;
  entityRemovedAt: Date | null;
  category: string | null;
};

export type AppealVerdict = 'Approved' | 'Rejected';

export type AppealWriteDeps = {
  linkedUser: AccountWriteDeps['linkedUser'];
  /** The `/images/appeals` page grant: the queue this ruling would otherwise be made in. */
  canAct: (user: App.Locals['user']) => boolean;
  appealOf: (id: number) => Promise<AppealRow | null>;
  /** The image queue's own reason rules, so a ruling from a ticket records what the queue would. */
  parseReason: (
    form: FormData,
    verdict: AppealVerdict
  ) => { resolvedReason: string; internalNotes: string | undefined } | string;
  /** `undefined` when no pending appeal was left to decide. */
  resolve: (input: {
    imageId: number;
    status: AppealVerdict;
    resolvedReason: string;
    internalNotes: string | undefined;
    userId: number;
  }) => Promise<unknown>;
  note: AccountWriteDeps['note'];
};

const ruling = z.object({ appealId: int4Id, status: z.enum(['Approved', 'Rejected']) });

const NOT_PERMITTED = 'Not permitted.';
const DECIDED = 'That appeal has already been decided — nothing was changed.';

/**
 * 🔴 THE APPEAL RULED ON IS THE TICKET USER'S. `resolveImageAppeal` is keyed by image and closes
 * whichever pending appeal exists, checking nothing about who filed it, so the appeal row is read here:
 * it must be pending, a plain image appeal (not removed-content, not a site form, not a model's) and
 * filed by the user the ticket links to. The image decided is the row's, never the form's.
 */
export function createTicketAppealActions(deps: AppealWriteDeps) {
  return {
    appealResolveImage: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user)) return fail(403, { error: NOT_PERMITTED });
      const input = parseForm(ruling, await event.request.clone().formData());
      if (typeof input === 'string') return fail(400, { error: input });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;

      const appeal = await deps.appealOf(input.appealId);
      if (!appeal) return fail(404, { error: 'Appeal not found.' });
      if (appeal.userId !== ok.userId)
        return fail(409, {
          error: 'That appeal belongs to another account — nothing was changed.',
        });
      if (appeal.status !== 'Pending') return fail(409, { error: DECIDED });
      if (
        appeal.entityType !== 'Image' ||
        appeal.entityRemovedAt !== null ||
        appeal.category !== null
      )
        return fail(409, {
          error:
            'That is not an image appeal; it is decided in its own queue — nothing was changed.',
        });

      const reason = deps.parseReason(ok.form, input.status);
      if (typeof reason === 'string') return fail(400, { error: reason });

      const closed = await deps.resolve({
        imageId: appeal.entityId,
        status: input.status,
        ...reason,
        userId: event.locals.user.id,
      });
      if (!closed) return fail(409, { error: DECIDED });
      return addTicketNote(
        deps.note,
        event,
        ok.ticketId,
        `${input.status} appeal #${input.appealId} (image ${appeal.entityId}) of user ${ok.userId}`
      );
    },
  };
}
