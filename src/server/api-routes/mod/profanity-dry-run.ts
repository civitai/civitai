import * as z from 'zod';
import { trackModActivity } from '~/server/services/moderator.service';
import { getServerProfanityFilter } from '~/server/services/profanity-list.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('profanityList.dryRun', {
  summary: 'Whether the server profanity filter flags a text, and which list it enforced.',
  returns:
    "{ flagged, listSource }; listSource is 'managed', 'stale', 'fallback' or 'shipped' (flag off)",
  notes: [
    'Runs the same filter as every server profanity check: masking, search refusal, auto-NSFW and app shared data.',
    'Returns the verdict only, never the entry that matched. The text is not written to the audit log.',
    'The text goes in the POST body; one in the query string is refused.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ text: z.string().trim().min(1).max(500) }),
  auditExclude: ['text'],
  async handler({ text }, ctx) {
    // Body only: a query string lands in access logs.
    if (ctx.req.query.text !== undefined) throwBadRequestError('Send the text in the POST body.');
    const profanity = await getServerProfanityFilter();
    const flagged = profanity.filter.analyze(text).isProfane;
    if (flagged) profanity.countHit('dryrun');
    await trackModActivity(ctx.actor.id, { entityType: 'profanityList', activity: 'dryRun' });
    return { flagged, listSource: profanity.source };
  },
});
