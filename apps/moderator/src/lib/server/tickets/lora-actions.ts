import { sql } from '@civitai/db/kysely';
import { dbWrite } from '../db';
import { canAccess } from '../access';
import { toggleCannotPublish } from '../training-moderation.service';
import { loraPanelFor } from '$lib/tickets/lora-panel';
import { linkedUserFor } from './account-actions';
import { createTicketLoraActions } from './lora-write';
import { ticketNote } from './ticket-note';

/** Read from the primary: the check is a precondition of a write, so replica lag must not decide it. */
const modelOf = async (modelId: number) =>
  (await dbWrite
    .selectFrom('Model')
    .select([
      'userId',
      sql<boolean>`COALESCE(meta->'cannotPublish' = 'true'::jsonb, false)`.as('cannotPublish'),
    ])
    .where('id', '=', modelId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst()) ?? null;

/** Setting or clearing a trained model's publish block from a support ticket, under the training models page's grant. */
export const ticketLoraActions = createTicketLoraActions({
  linkedUser: linkedUserFor(
    loraPanelFor,
    'This is not a LoRA trainer ticket — nothing was changed.'
  ),
  canAct: (user, path) => canAccess(user, path),
  modelOf,
  toggleCannotPublish,
  note: ticketNote,
});
