import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { checkboxField, parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { isClickhouseDateTime } from '$lib/server/clickhouse-date';
import {
  getImageRemovals,
  getModActivityPage,
  getModActivitySummary,
  getRetoolActivity,
} from '$lib/server/user-account.service';

const querySchema = z.object({
  view: z.enum(['page', 'summary', 'retool', 'removals']).catch('page'),
  ratings: checkboxField.catch(false),
  activity: z.string().trim().max(200).optional().catch(undefined),
  type: z.string().trim().max(50).optional().catch(undefined),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/)
    .optional()
    .catch(undefined),
  beforeId: z.coerce.number().int().positive().max(MAX_INT4).optional().catch(undefined),
  /** The removals cursor: ClickHouse's own `YYYY-MM-DD HH:MM:SS`, not the ModActivity ISO form. */
  removedBefore: z.string().refine(isClickhouseDateTime).optional().catch(undefined),
});

// Fetched client-side like the security signals, so the identity render path never waits on it.
// Separate views because they change on different inputs: a page with every filter and cursor, the filter
// summary only with the ratings toggle (about a second on the largest accounts, too much to repeat per
// page), the Retool era with nothing at all, and the ClickHouse image removals with their own cursor.
export const GET: RequestHandler = async ({ params, locals, url }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');
  const q = parseQuery(url, querySchema);

  // Kept apart from the ModActivity rows: those have entity links and a real moderator id; the Retool
  // rows have neither, and merging them would imply a continuity that the data does not have.
  if (q.view === 'retool') return json(await getRetoolActivity(userId));
  if (q.view === 'removals')
    return json(
      await getImageRemovals(
        userId,
        q.removedBefore && q.beforeId ? { at: q.removedBefore, imageId: q.beforeId } : undefined
      )
    );

  // Crowd votes and tag edits are hidden unless asked for: a creator rated by Knights of New Order
  // carries tens of thousands of them, enough to bury every moderator decision on the account.
  const bucket = q.ratings ? undefined : 'enforcement';
  if (q.view === 'summary') return json(await getModActivitySummary(userId, bucket));

  return json(
    await getModActivityPage({
      userId,
      bucket,
      activity: q.activity || undefined,
      entityType: q.type || undefined,
      before: q.before && q.beforeId ? { at: q.before, id: q.beforeId } : undefined,
    })
  );
};
