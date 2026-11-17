import * as z from 'zod';
import { trackModActivity } from '~/server/services/moderator.service';
import { dryRunSemanticQuery } from '~/server/services/semantic-query-guard';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('searchQueryRules.dryRun', {
  summary:
    'What the semantic search query audit would do to a query, for a non-moderator and for a moderator.',
  returns:
    "{ nonModerator: { verdict, result }, moderator: { verdict, result } }; result is 'allow', 'narrow' or 'refuse'",
  notes: [
    'Runs the same audit as the semantic search boxes, the moderator-edited query rules included, at every browsing level.',
    'Returns the verdict only, never the list or term that matched. The query is not written to the audit log.',
    'The query goes in the POST body; one in the query string is refused.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: z.object({ query: z.string().trim().min(1).max(500) }),
  auditExclude: ['query'],
  async handler({ query }, ctx) {
    // Body only: a query string lands in access logs.
    if (ctx.req.query.query !== undefined) throwBadRequestError('Send the query in the POST body.');
    const result = await dryRunSemanticQuery(query);
    await trackModActivity(ctx.actor.id, { entityType: 'searchQueryRule', activity: 'dryRun' });
    return result;
  },
});
