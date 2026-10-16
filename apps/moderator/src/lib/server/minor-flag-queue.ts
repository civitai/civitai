import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { parseQuery } from '$lib/server/query';
import { rulingReasonFromForm } from '$lib/server/resolution-reason';
import {
  getMinorFlagAppealGroups,
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview,
  getMinorQueueCounts,
  getFlaggedCount,
  getFlaggedModels,
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
  DEFAULT_FLAGGED_FILTERS,
  FLAGGED_FLAGS,
  FLAGGED_SORTS,
  FLAGGED_SOURCES,
  type FlaggedFilters,
} from '$lib/minor-flags/flagged-filters';
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

const flaggedFilterSchema = z.object({
  source: z.enum(FLAGGED_SOURCES).catch(DEFAULT_FLAGGED_FILTERS.source),
  flag: z.enum(FLAGGED_FLAGS).catch(DEFAULT_FLAGGED_FILTERS.flag),
  sort: z.enum(FLAGGED_SORTS).catch(DEFAULT_FLAGGED_FILTERS.sort),
});

function parsePaging(url: URL) {
  const { limit, page, q } = parseQuery(url, querySchema);
  const numeric = /^\d+$/.test(q) ? Number(q) : null;
  const search: MinorSearch | undefined = !q
    ? undefined
    : numeric !== null
    ? { modelOrUserId: numeric > MAX_INT4 ? 0 : numeric }
    : { username: q };
  return { limit, page, q, offset: (page - 1) * limit, search };
}

/**
 * The File matches list. Its total is the cached queue count, which costs ~10s cold, so it is
 * bounded: a slow count drops the "of N" instead of holding the page. A search narrows the list, not the
 * count, so the total is only offered for the whole queue.
 *
 * ⚠️ Offset paging over a queue moderators are draining SKIPS rows: action a row on page 1 and every
 * later row shifts up one, so page 2 starts past something never seen. The shell's "Refresh queue"
 * re-cuts the page after acting.
 */
const TOTAL_BUDGET_MS = 1_000;

export async function loadMatchesQueue(url: URL) {
  const { limit, page, q, offset, search } = parsePaging(url);

  const [queue, total] = await Promise.all([
    getMinorHashMatchesForReview({ limit, offset, search }),
    search
      ? undefined
      : Promise.race([
          getMinorQueueCounts().then((counts) => counts.pending),
          new Promise<undefined>((resolve) => setTimeout(resolve, TOTAL_BUDGET_MS)),
        ]).catch((err) => {
          console.error('File matches total failed', err);
          return undefined;
        }),
  ]);

  return { limit, page, offset, q, total, ...queue, fullBleed: true };
}

export type MatchesQueueData = Awaited<ReturnType<typeof loadMatchesQueue>>;

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

export async function loadFlaggedQueue(url: URL) {
  const { limit, page, q, offset, search } = parsePaging(url);
  const flaggedFilters: FlaggedFilters = parseQuery(url, flaggedFilterSchema);
  const [queue, total] = await Promise.all([
    getFlaggedModels({ limit, offset, search, filters: flaggedFilters }),
    // The footer's "of N" is decoration; a failure here must not take the list down with it.
    getFlaggedCount({ search, source: flaggedFilters.source, flag: flaggedFilters.flag }).catch(
      (err) => {
        console.error('Flagged total failed', err);
        return undefined;
      }
    ),
  ]);
  return { limit, page, offset, q, flaggedFilters, total, ...queue, fullBleed: true };
}

export type FlaggedQueueData = Awaited<ReturnType<typeof loadFlaggedQueue>>;

/** The shell prefixes a refusal with this so a moderator knows which item it was about. */
const modelSubject = (modelId: number) => `Model #${modelId}`;

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
  if (!result.ok)
    return fail(400, {
      error: result.error ?? 'Action failed.',
      modelId,
      subject: modelSubject(modelId),
    });
  return { success: true, modelId, rescanQueued: result.rescanQueued === true };
};

/** Flag a file match as minor, or dismiss it. The main app's endpoints take the model id only. */
export const matchesActions: Actions = {
  setMinor: (event) => run(event, setModelMinorFlag),
  dismiss: (event) => run(event, dismissMinorHashMatch),
};

const flaggedAction =
  (keep: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    const label = z.enum(['minor', 'poi']).safeParse(form.get('label'));
    const source = z.enum(['hash', 'redetected']).safeParse(form.get('source'));
    if (!(modelId > 0) || !label.success || !source.success)
      return fail(400, { error: 'Missing model id, label or source.' });
    const refusal = (error: string) =>
      fail(400, { error, modelId, subject: modelSubject(modelId) });

    if (source.data === 'hash') {
      // Hash flags are minor flags; a poi label here would still lift or keep the minor flag.
      if (label.data !== 'minor') return refusal('A hash flag can only be ruled as minor.');
      // The main app's confirm and revert endpoints take no reason yet, so none is read or recorded.
      const result = await (keep ? confirmMinorFlag : revertMinorFlag)(modelId);
      if (!result.ok) return refusal(result.error ?? 'Action failed.');
      return { success: true, modelId, label: label.data, resolved: keep ? 'kept' : 'dismissed' };
    }

    const textHash = z.string().min(1).max(200).safeParse(form.get('textHash'));
    if (!textHash.success) return fail(400, { error: 'Missing text hash.' });
    const reason = rulingReasonFromForm('heldDetection', keep ? 'Kept' : 'Dismissed', form, [
      label.data,
    ]);
    if (typeof reason === 'string') return refusal(reason);

    const result = await resolveRedetection(modelId, label.data, keep, textHash.data, reason);
    if (!result.ok) return refusal(result.error);
    return { success: true, modelId, label: label.data, resolved: result.resolved };
  };

/** Keep or lift a flag from the Flagged tab, whatever raised it. */
export const flaggedActions: Actions = {
  keepFlag: flaggedAction(true),
  liftFlag: flaggedAction(false),
};

const wholeAppealAction =
  (uphold: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    if (!(modelId > 0)) return fail(400, { error: 'Missing model id.' });
    const reason = rulingReasonFromForm('flagAppeal', uphold ? 'Rejected' : 'Approved', form);
    if (typeof reason === 'string')
      return fail(400, { error: reason, modelId, subject: modelSubject(modelId) });

    const result = await resolveMinorFlagAppeal(modelId, uphold, reason);
    if (!result.ok)
      return fail(400, { error: result.error, modelId, subject: modelSubject(modelId) });
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
    // The verdict rule from `RULINGS` in AppealDetail.svelte.
    const lifted = (['minor', 'poi'] as const).filter(
      (label) => ({ minor, poi }[label].data === 'overturn')
    );
    const reason = rulingReasonFromForm(
      'flagAppeal',
      lifted.length ? 'Approved' : 'Rejected',
      form,
      lifted.length ? lifted : undefined
    );
    if (typeof reason === 'string')
      return fail(400, { error: reason, modelId, subject: modelSubject(modelId) });

    const result = await resolveMinorFlagAppealPerLabel(
      modelId,
      { minor: minor.data, poi: poi.data },
      reason
    );
    if (!result.ok)
      return fail(400, { error: result.error, modelId, subject: modelSubject(modelId) });
    return { success: true, modelId, rescanQueued: result.rescanQueued };
  },
};
