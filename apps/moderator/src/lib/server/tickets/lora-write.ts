import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { TRAINING_MODELS_PATH } from '$lib/tickets/lora-panel';
import { int4Id, parseForm } from '../query';
import { addTicketNote, checkTicketTarget, type TicketActionDeps } from './panel-write';

export type LoraWriteDeps = TicketActionDeps & {
  /** The viewer's grant on a page, checked as the page's own action is. */
  canAct: (user: App.Locals['user'], path: string) => boolean;
  /** The model's owner and publish block, read live from the primary. Null for a missing or deleted model. */
  modelOf: (modelId: number) => Promise<{ userId: number; cannotPublish: boolean } | null>;
  toggleCannotPublish: (
    modelId: number
  ) => Promise<{ ok: true; cannotPublish: boolean } | { ok: false; error: string }>;
};

const NOT_PERMITTED = 'Not permitted.';

const input = z.object({ modelId: int4Id, cannotPublish: z.enum(['true', 'false']) });

/**
 * 🔴 GATED AS THE TRAINING MODELS PAGE'S OWN `toggleCannotPublish` IS: its page grant and nothing more
 * (that action carries no `requiresGrant`), on the page's own path. The service only flips, so the form
 * names the state it wants: a stale card or a second agent cannot flip a block back, and the model must
 * be the ticket user's own.
 */
export function createTicketLoraActions(deps: LoraWriteDeps) {
  return {
    loraSetPublishBlock: async (event: RequestEvent) => {
      if (!deps.canAct(event.locals.user, TRAINING_MODELS_PATH))
        return fail(403, { error: NOT_PERMITTED });
      const ok = await checkTicketTarget(deps.linkedUser, event);
      if (ok.refused) return ok.refused;

      const parsed = parseForm(input, ok.form);
      if (typeof parsed === 'string') return fail(400, { error: parsed });
      const want = parsed.cannotPublish === 'true';

      const model = await deps.modelOf(parsed.modelId);
      if (!model) return fail(404, { error: 'Model not found.' });
      if (model.userId !== ok.userId)
        return fail(409, {
          error: 'That model belongs to another account — nothing was changed.',
        });
      if (model.cannotPublish === want)
        return fail(409, {
          error: `Publishing is already ${want ? 'blocked' : 'allowed'} for that model — nothing was changed.`,
        });

      const result = await deps.toggleCannotPublish(parsed.modelId);
      if (!result.ok) return fail(400, { error: result.error });
      if (result.cannotPublish !== want)
        return fail(409, {
          error: `Someone else changed that model at the same moment: publishing is now ${
            result.cannotPublish ? 'blocked' : 'allowed'
          }, not ${want ? 'blocked' : 'allowed'}. Check the model before trying again.`,
        });

      return addTicketNote(
        deps.note,
        event,
        ok.ticketId,
        `${want ? 'Blocked' : 'Allowed'} publishing of model ${parsed.modelId} (user ${ok.userId})`
      );
    },
  };
}
