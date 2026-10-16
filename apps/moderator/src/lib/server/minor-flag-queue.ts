import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { parseQuery } from '$lib/server/query';
import { rulingReasonFromForm } from '$lib/server/resolution-reason';
import {
  getAutoFlaggedMinorModels,
  getMinorFlagAppealGroups,
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview,
  getModelMinorState,
  getRedetectedCount,
  getRedetectedModels,
  type MinorSearch,
} from '$lib/server/minor-hash.service';
import {
  APPEAL_FLAGS,
  APPEAL_SORTS,
  APPEAL_SOURCES,
  appealFacets,
  DEFAULT_APPEAL_FILTERS,
  type AppealFilters,
} from '$lib/minor-flags/appeal-filters';
import {
  DEFAULT_REDETECTED_FILTERS,
  REDETECTED_FLAGS,
  REDETECTED_SORTS,
  type RedetectedFilters,
} from '$lib/minor-flags/redetected-filters';
import { MAX_INT4 } from '$lib/server/users.service';
import {
  confirmMinorFlag,
  dismissMinorHashMatch,
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
  resolveRedetection,
  revertMinorFlag,
  setModelMinorFlag,
} from '$lib/server/minor-flag.service';

export type MinorQueueView = 'pending' | 'auto';

const querySchema = z.object({
  limit: z.coerce.number().int().min(10).max(200).catch(50),
  page: z.coerce.number().int().min(1).max(500).catch(1),
  q: z.string().trim().max(100).catch(''),
});

const appealFilterSchema = z.object({
  source: z.enum(APPEAL_SOURCES).catch(DEFAULT_APPEAL_FILTERS.source),
  flag: z.enum(APPEAL_FLAGS).catch(DEFAULT_APPEAL_FILTERS.flag),
  sort: z.enum(APPEAL_SORTS).catch(DEFAULT_APPEAL_FILTERS.sort),
});

const redetectedFilterSchema = z.object({
  flag: z.enum(REDETECTED_FLAGS).catch(DEFAULT_REDETECTED_FILTERS.flag),
  sort: z.enum(REDETECTED_SORTS).catch(DEFAULT_REDETECTED_FILTERS.sort),
});

function parsePaging(url: URL) {
  const { limit, page, q } = parseQuery(url, querySchema);
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const search: MinorSearch | undefined = !q
    ? undefined
    : numeric !== null
    ? { modelOrUserId: numeric > MAX_INT4 ? 0 : numeric }
    : { username: q };
  return { limit, page, q, offset: (page - 1) * limit, numeric, search };
}

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
  const { limit, page, q, offset, numeric, search } = parsePaging(url);

  const [queue, lookup] = await Promise.all([
    tab === 'auto'
      ? getAutoFlaggedMinorModels({ limit, offset, search })
      : getMinorHashMatchesForReview({ limit, offset, search }),
    numeric !== null && numeric <= MAX_INT4 ? getModelMinorState(numeric) : null,
  ]);

  return { tab, limit, page, offset, q, lookup, tabs, ...queue, wide: true };
}

export type MinorQueueData = Awaited<ReturnType<typeof loadMinorQueue>>;

export async function loadAppealQueue(url: URL) {
  const { limit, page, q, offset, search } = parsePaging(url);
  const appealFilters: AppealFilters = parseQuery(url, appealFilterSchema);

  const [queue, groups] = await Promise.all([
    getMinorFlagAppealsForReview({ limit, offset, search, filters: appealFilters }),
    // The counts are decoration; a failure here must not take the list down with it.
    getMinorFlagAppealGroups({ search }).catch((err) => {
      console.error('Appeal facet counts failed', err);
      return null;
    }),
  ]);

  const facets = groups ? appealFacets(groups, appealFilters) : null;
  return { limit, page, offset, q, appealFilters, facets, ...queue, fullBleed: true };
}

export type AppealQueueData = Awaited<ReturnType<typeof loadAppealQueue>>;

export async function loadRedetectedQueue(url: URL) {
  const { limit, page, q, offset, search } = parsePaging(url);
  const redetectedFilters: RedetectedFilters = parseQuery(url, redetectedFilterSchema);
  const [queue, total] = await Promise.all([
    getRedetectedModels({ limit, offset, search, filters: redetectedFilters }),
    // The footer's "of N" is decoration; a failure here must not take the list down with it.
    getRedetectedCount({ search, flag: redetectedFilters.flag }).catch((err) => {
      console.error('Re-detected total failed', err);
      return undefined;
    }),
  ]);
  return { limit, page, offset, q, redetectedFilters, total, ...queue, fullBleed: true };
}

export type RedetectedQueueData = Awaited<ReturnType<typeof loadRedetectedQueue>>;

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

const redetectionAction =
  (keep: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    const label = z.enum(['minor', 'poi']).safeParse(form.get('label'));
    const textHash = z.string().min(1).max(200).safeParse(form.get('textHash'));
    if (!(modelId > 0) || !label.success || !textHash.success)
      return fail(400, { error: 'Missing model id, label or text hash.' });
    const reason = rulingReasonFromForm('heldDetection', keep ? 'Kept' : 'Dismissed', form, [
      label.data,
    ]);
    if (typeof reason === 'string') return fail(400, { error: reason, modelId });

    const result = await resolveRedetection(modelId, label.data, keep, textHash.data, reason);
    if (!result.ok) return fail(400, { error: result.error, modelId });
    return { success: true, modelId, label: label.data, resolved: result.resolved };
  };

export const redetectionActions: Actions = {
  keepRedetected: redetectionAction(true),
  dismissRedetected: redetectionAction(false),
};

const wholeAppealAction =
  (uphold: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    if (!(modelId > 0)) return fail(400, { error: 'Missing model id.' });
    const reason = rulingReasonFromForm('flagAppeal', uphold ? 'Rejected' : 'Approved', form);
    if (typeof reason === 'string') return fail(400, { error: reason, modelId });

    const result = await resolveMinorFlagAppeal(modelId, uphold, reason);
    if (!result.ok) return fail(400, { error: result.error, modelId });
    return { success: true, modelId, rescanQueued: result.rescanQueued === true };
  };

export const appealActions: Actions = {
  upholdAppeal: wholeAppealAction(true),
  overturnAppeal: wholeAppealAction(false),
  splitAppeal: async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    const decision = z.enum(['uphold', 'overturn']);
    const minor = decision.safeParse(form.get('minor'));
    const poi = decision.safeParse(form.get('poi'));
    if (!(modelId > 0) || !minor.success || !poi.success)
      return fail(400, { error: 'Missing model id or decision.' });
    // The main app closes the appeal Approved when any label is lifted.
    const lifted = (['minor', 'poi'] as const).filter(
      (label) => ({ minor, poi }[label].data === 'overturn')
    );
    const reason = rulingReasonFromForm(
      'flagAppeal',
      lifted.length ? 'Approved' : 'Rejected',
      form,
      lifted.length ? lifted : undefined
    );
    if (typeof reason === 'string') return fail(400, { error: reason, modelId });

    const result = await resolveMinorFlagAppealPerLabel(
      modelId,
      { minor: minor.data, poi: poi.data },
      reason
    );
    if (!result.ok) return fail(400, { error: result.error, modelId });
    return { success: true, modelId, rescanQueued: result.rescanQueued };
  },
};
