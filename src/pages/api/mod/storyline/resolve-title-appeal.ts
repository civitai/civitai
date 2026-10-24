import * as z from 'zod';
import { resolveStorylineTitleAppeal } from '~/server/services/storyline.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('storyline.resolveTitleAppeal', {
  summary: "Rule on a storyline owner's appeal of a takedown made by the title scan.",
  returns: '{ resolved, storylineId }',
  notes: [
    'Granting lifts the scan takedown for `reviewedTitle`, so a rescan of that title does not take it down again.',
    'Granting refuses, leaving the appeal open, when the title has changed since it was reviewed.',
    "Granting refuses while a moderator's own takedown holds; denying refuses when no takedown holds.",
    'Refuses when there is no open appeal, or another moderator ruled on it first.',
  ],
  input: z.object({
    storylineId: z.coerce.number().int().positive().describe('The storyline to act on.'),
    grant: moderatorBoolean.describe('True grants the appeal and lifts the takedown.'),
    reviewedTitle: z.string().describe('The title the moderator reviewed.'),
  }),
  async handler(input, ctx) {
    await resolveStorylineTitleAppeal({
      id: input.storylineId,
      grant: input.grant,
      reviewedTitle: input.reviewedTitle,
      userId: ctx.actor.id,
    });
    return {
      resolved: input.grant ? 'granted' : 'denied',
      storylineId: input.storylineId,
      affected: { storylineIds: [input.storylineId] },
    };
  },
});
