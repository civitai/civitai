import * as z from 'zod';
import { moderateStorylineTitle } from '~/server/services/storyline.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('storyline.liftTitleTakedown', {
  summary:
    'Lift a takedown the title scan made on a storyline, for the title the moderator reviewed.',
  returns: '{ storylineId, tosViolation, tosViolationByScan, tosViolationByModerator }',
  notes: [
    'Records the reviewed title, so a rescan of that title does not take it down again.',
    'Refuses when the title has changed since it was reviewed, or the scan holds no takedown.',
    "A moderator's own takedown is not lifted, and keeps the storyline down.",
    "An open appeal of the takedown is approved with it (marked as a direct lift, not a reviewed appeal) and the owner is notified, unless a moderator's takedown still holds the storyline down.",
  ],
  input: z.object({
    storylineId: z.coerce.number().int().positive().describe('The storyline to act on.'),
    reviewedTitle: z.string().describe('The title the moderator reviewed.'),
  }),
  async handler(input, ctx) {
    const storyline = await moderateStorylineTitle({
      id: input.storylineId,
      liftScanTakedown: { reviewedTitle: input.reviewedTitle },
      moderatorId: ctx.actor.id,
    });
    return {
      storylineId: storyline.id,
      tosViolation: storyline.tosViolation,
      tosViolationByScan: storyline.tosViolationByScan,
      tosViolationByModerator: storyline.tosViolationByModerator,
      affected: { storylineIds: [storyline.id] },
    };
  },
});
