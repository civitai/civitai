import * as z from 'zod';

import {
  APP_REACTION_ENTITY_TYPES,
  APP_REACTION_READ_MAX_IDS,
  REACT_TICKET_MAX_LENGTH,
} from '~/shared/constants/block-reaction.constants';
import { ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * Inputs for `blocks.setReactionFromApp` / `blocks.getReactionsForApp`.
 *
 * Lives apart from `reaction.schema.ts` on purpose: that schema is the SITE's toggle input,
 * and the app input differs from it in kind — a desired STATE (`reacted`) rather than a toggle,
 * a block token, and a provenance ticket.
 *
 * `reaction` accepts every stored reaction here and the allowlist (`APP_IMAGE_REACTIONS`) is
 * applied in the procedure, so a `Dislike` is refused with that guard's own message rather than
 * as a generic validation failure.
 */
const ticketInput = z.string().min(1).max(REACT_TICKET_MAX_LENGTH);

export const setReactionFromAppSchema = z.object({
  blockToken: z.string().min(1),
  entityType: z.enum(APP_REACTION_ENTITY_TYPES),
  entityId: z.number().int().positive(),
  reaction: z.enum(ReviewReactions),
  /** The state the viewer wants: true ⇒ the reaction exists afterwards, false ⇒ it does not. */
  reacted: z.boolean(),
  /** Optional on the wire so the procedure, not the schema, owns the refusal. */
  ticket: ticketInput.optional(),
});
export type SetReactionFromAppInput = z.infer<typeof setReactionFromAppSchema>;

export const getReactionsForAppSchema = z.object({
  blockToken: z.string().min(1),
  entityType: z.enum(APP_REACTION_ENTITY_TYPES),
  ids: z.array(z.number().int().positive()).min(1).max(APP_REACTION_READ_MAX_IDS),
  /** Ticket per id, keyed by the id as a string. An id without a valid one is not answered. */
  tickets: z.record(z.string(), ticketInput).optional(),
});
export type GetReactionsForAppInput = z.infer<typeof getReactionsForAppSchema>;
