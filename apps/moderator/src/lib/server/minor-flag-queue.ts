import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { parseQuery } from '$lib/server/query';
import {
  getAutoFlaggedMinorModels,
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview,
  getModelMinorState,
  type MinorSearch,
} from '$lib/server/minor-hash.service';
import { MAX_INT4 } from '$lib/server/users.service';
import {
  confirmMinorFlag,
  dismissMinorHashMatch,
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
  revertMinorFlag,
  setModelMinorFlag,
} from '$lib/server/minor-flag.service';

export type MinorQueueView = 'pending' | 'auto' | 'appeals';

const querySchema = z.object({
  limit: z.coerce.number().int().min(10).max(200).catch(50),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  q: z.string().trim().max(100).catch(''),
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
export async function loadMinorQueue(
  url: URL,
  tab: MinorQueueView,
  tabs: readonly { value: MinorQueueView; label: string }[] | null
) {
  const { limit, page, q } = parseQuery(url, querySchema);
  const offset = (page - 1) * limit;

  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const search: MinorSearch | undefined = !q
    ? undefined
    : numeric !== null
    ? { modelOrUserId: numeric > MAX_INT4 ? 0 : numeric }
    : { username: q };

  const [queue, lookup] = await Promise.all([
    tab === 'auto'
      ? getAutoFlaggedMinorModels({ limit, offset, search })
      : tab === 'appeals'
      ? getMinorFlagAppealsForReview({ limit, offset, search })
      : getMinorHashMatchesForReview({ limit, offset, search }),
    tab !== 'appeals' && numeric !== null && numeric <= MAX_INT4
      ? getModelMinorState(numeric)
      : null,
  ]);

  return { tab, limit, page, offset, q, lookup, tabs, ...queue, wide: true };
}

export type MinorQueueData = Awaited<ReturnType<typeof loadMinorQueue>>;

const modelIdFrom = async (event: RequestEvent) => {
  const form = await event.request.formData();
  const modelId = Number(form.get('modelId'));
  return modelId > 0 ? modelId : null;
};

/** Every action reports the failure rather than swallowing it: these are minor-safety verdicts, and a
 *  refused write that renders as success is the worst outcome available here. */
const run = async (
  event: RequestEvent,
  action: (modelId: number) => Promise<{ ok: boolean; error?: string; rescanQueued?: boolean }>
) => {
  const modelId = await modelIdFrom(event);
  if (!modelId) return fail(400, { error: 'Missing model id.' });

  const result = await action(modelId);
  if (!result.ok) return fail(400, { error: result.error ?? 'Action failed.', modelId });
  return { success: true, modelId, rescanQueued: result.rescanQueued === true };
};

export const minorHashActions: Actions = {
  setMinor: (event) => run(event, setModelMinorFlag),
  confirm: (event) => run(event, confirmMinorFlag),
  revert: (event) => run(event, revertMinorFlag),
  dismiss: (event) => run(event, dismissMinorHashMatch),
};

export const appealActions: Actions = {
  upholdAppeal: (event) => run(event, (id) => resolveMinorFlagAppeal(id, true)),
  overturnAppeal: (event) => run(event, (id) => resolveMinorFlagAppeal(id, false)),
  // Reads its own form: `run` consumes the body for the model id alone.
  splitAppeal: async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    const decision = z.enum(['uphold', 'overturn']);
    const minor = decision.safeParse(form.get('minor'));
    const poi = decision.safeParse(form.get('poi'));
    if (!(modelId > 0) || !minor.success || !poi.success)
      return fail(400, { error: 'Missing model id or decision.' });

    const result = await resolveMinorFlagAppealPerLabel(modelId, {
      minor: minor.data,
      poi: poi.data,
    });
    if (!result.ok) return fail(400, { error: result.error, modelId });
    return { success: true, modelId, rescanQueued: result.rescanQueued };
  },
};
