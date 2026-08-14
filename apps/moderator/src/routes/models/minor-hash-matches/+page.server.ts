import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad, RequestEvent } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  getAutoFlaggedMinorModels,
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview,
} from '$lib/server/minor-hash.service';
import {
  confirmMinorFlag,
  dismissMinorHashMatch,
  resolveMinorFlagAppeal,
  revertMinorFlag,
  setModelMinorFlag,
} from '$lib/server/minor-flag.service';
import { TABS } from './tabs';

const querySchema = z.object({
  tab: z.enum(['pending', 'auto', 'appeals']).catch('pending'),
  limit: z.coerce.number().int().min(10).max(200).catch(50),
  page: z.coerce.number().int().min(1).max(500).catch(1),
});

/**
 * Only the open tab's ROWS are queried here. The tab counts come from `/api/minor-queue-counts`,
 * client-side and cached, because the Pending count costs ~10s on its own — it rebuilds the same seed
 * set and candidate CTE this query does, then counts the whole population instead of one page of it.
 *
 * ⚠️ Offset paging over a queue moderators are draining SKIPS rows: action a row on page 1 and every
 * later row shifts up one, so page 2 starts past something never seen. It is the right trade here —
 * the alternative is a keyset over a CTE with no monotonic column — but a moderator working straight
 * through should re-read page 1 after acting rather than paging forward.
 */
export const load: PageServerLoad = async ({ url }) => {
  const { tab, limit, page } = parseQuery(url, querySchema);
  const offset = (page - 1) * limit;

  const queue =
    tab === 'auto'
      ? await getAutoFlaggedMinorModels({ limit, offset })
      : tab === 'appeals'
        ? await getMinorFlagAppealsForReview({ limit, offset })
        : await getMinorHashMatchesForReview({ limit, offset });

  return { tab, limit, page, offset, tabs: TABS, ...queue, wide: true };
};

const modelIdFrom = async (event: RequestEvent) => {
  const form = await event.request.formData();
  const modelId = Number(form.get('modelId'));
  return modelId > 0 ? modelId : null;
};

/** Every action reports the failure rather than swallowing it: these are minor-safety verdicts, and a
 *  refused write that renders as success is the worst outcome available here. */
const run = async (event: RequestEvent, action: (modelId: number) => Promise<{ ok: boolean; error?: string }>) => {
  const modelId = await modelIdFrom(event);
  if (!modelId) return fail(400, { error: 'Missing model id.' });

  const result = await action(modelId);
  if (!result.ok) return fail(400, { error: result.error ?? 'Action failed.', modelId });
  return { success: true, modelId };
};

export const actions: Actions = {
  setMinor: (event) => run(event, setModelMinorFlag),
  confirm: (event) => run(event, confirmMinorFlag),
  revert: (event) => run(event, revertMinorFlag),
  dismiss: (event) => run(event, dismissMinorHashMatch),
  upholdAppeal: (event) => run(event, (id) => resolveMinorFlagAppeal(id, true)),
  overturnAppeal: (event) => run(event, (id) => resolveMinorFlagAppeal(id, false)),
};
