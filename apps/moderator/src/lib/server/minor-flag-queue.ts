import { fail, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, RequestEvent } from '@sveltejs/kit';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  checkedResolutionReason,
  resolutionReasonFields,
  rulingReasonFromForm,
} from '$lib/server/resolution-reason';
import {
  FLAG_LABEL_NAMES,
  decisionReasonFor,
  flagRefId,
  flagRuling,
  parseKeptIds,
  planDecision,
  type FlagRef,
  type PlannedFlag,
  withRuling,
} from '$lib/minor-flags/flagged-decision';
import {
  getMinorFlagAppealGroups,
  getMinorFlagAppealsForReview,
  getMinorHashMatchesForReview,
  getMinorQueueCounts,
  getFlaggedCount,
  getFlaggedModels,
  getModelFlagDetail,
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
  ruleTextScanFlag,
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
  let budget: number | undefined;

  const [queue, total] = await Promise.all([
    getMinorHashMatchesForReview({ limit, offset, search }),
    search
      ? undefined
      : Promise.race([
          getMinorQueueCounts().then((counts) => counts.pending),
          new Promise<undefined>((resolve) => {
            budget = setTimeout(resolve, TOTAL_BUDGET_MS);
          }),
        ])
          .catch((err) => {
            console.error('File matches total failed', err);
            return undefined;
          })
          .finally(() => clearTimeout(budget)),
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

/** At most this many prompt ids per request: a pane shows two labels' entries. */
const MAX_PROMPT_IDS = 10;

/**
 * Each tab's `detail/[modelId]` endpoint: the facts only the open detail pane shows, fetched when a row
 * is selected so the paged list never pays for them. Served under each tab's own path, so the global
 * route gate checks that tab's grant.
 */
export async function modelFlagDetailResponse(rawModelId: string, url: URL) {
  const modelId = Number(rawModelId);
  if (!Number.isInteger(modelId) || modelId <= 0 || modelId > MAX_INT4)
    return json({ error: 'Bad model id.' }, { status: 400 });
  const promptIds = [
    ...new Set(
      (url.searchParams.get('prompts') ?? '')
        .split(',')
        .map(Number)
        .filter((id) => Number.isInteger(id) && id > 0 && id <= MAX_INT4)
    ),
  ].slice(0, MAX_PROMPT_IDS);
  const detail = await getModelFlagDetail({ modelId, promptIds });
  if (!detail) return json({ error: 'No such model.' }, { status: 404 });
  return json(detail);
}

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

type RulingReason = { resolvedReason: string; internalNotes: string | undefined };

/** Rules one flag through the path its source owns: hash flags through the main app's confirm and
 *  revert endpoints (no reason yet), text-scan flags through `ruleTextScanFlag`, re-detections through
 *  `resolveRedetection`. The caller has checked the label, text hash and reason. */
async function ruleFlag(
  modelId: number,
  flag: FlagRef,
  keep: boolean,
  reason: RulingReason | null
): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  if (flag.source === 'hash') {
    const result = await (keep ? confirmMinorFlag : revertMinorFlag)(modelId);
    return result.ok
      ? { ok: true, resolved: keep ? 'kept' : 'dismissed' }
      : { ok: false, error: result.error ?? 'Action failed.' };
  }
  const textHash = flag.textHash!;
  if (flag.source === 'text-scan') {
    const result = await ruleTextScanFlag({
      modelId,
      label: flag.label,
      keep,
      textHash,
      reason: reason!,
    });
    return result.ok ? { ok: true, resolved: result.ruled } : { ok: false, error: result.error };
  }
  const result = await resolveRedetection(modelId, flag.label, keep, textHash, reason!);
  return result.ok ? { ok: true, resolved: result.resolved } : { ok: false, error: result.error };
}

const flaggedAction =
  (keep: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    const posted = form.get('label');
    const label = z.enum(['minor', 'poi']).safeParse(posted);
    const source = z.enum(['hash', 'redetected', 'text-scan']).safeParse(form.get('source'));
    if (!(modelId > 0) || !source.success)
      return fail(400, { error: 'Missing model id, label or source.' });
    const refusal = (error: string) =>
      fail(400, { error, modelId, subject: modelSubject(modelId) });

    if (source.data === 'hash') {
      // Hash flags are minor flags; a poi label here would still lift or keep the minor flag.
      if (posted !== null && !(label.success && label.data === 'minor'))
        return refusal('A hash flag can only be ruled as minor.');
      // The main app's confirm and revert endpoints take no reason yet, so none is read or recorded.
      const result = await ruleFlag(
        modelId,
        { label: 'minor', source: 'hash', textHash: null },
        keep,
        null
      );
      if (!result.ok) return refusal(result.error);
      return { success: true, modelId, label: 'minor', resolved: result.resolved };
    }

    if (!label.success) return fail(400, { error: 'Missing model id, label or source.' });
    const textHash = z.string().min(1).max(200).safeParse(form.get('textHash'));
    if (!textHash.success) return fail(400, { error: 'Missing text hash.' });
    const flag: FlagRef = { label: label.data, source: source.data, textHash: textHash.data };
    const ruling = flagRuling({ source: flag.source, keep })!;
    const reason = withRuling(ruling, (subject, verdict) =>
      rulingReasonFromForm(subject, verdict, form, [flag.label])
    );
    if (typeof reason === 'string') return refusal(reason);

    const result = await ruleFlag(modelId, flag, keep, reason);
    if (!result.ok) return refusal(result.error);
    return { success: true, modelId, label: flag.label, resolved: result.resolved };
  };

const flagRefSchema = z.object({
  label: z.enum(['minor', 'poi']),
  source: z.enum(['hash', 'redetected', 'text-scan']),
  textHash: z.string().min(1).max(200).nullable(),
});
const SOURCE_NAMES: Record<FlagRef['source'], string> = {
  hash: 'hash',
  'text-scan': 'text scan',
  redetected: 're-detection',
};
const flagName = (flag: FlagRef) => {
  const name = FLAG_LABEL_NAMES[flag.label];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${SOURCE_NAMES[flag.source]})`;
};

/**
 * One decision over every flag a Flagged row carries: `flags` lists them, the pressed button's `keep`
 * names the ones kept, and every other one is reverted. Each flag is ruled through its own source's
 * path (`ruleFlag`). Every check runs before the first write, so a refusal changes nothing; a failure
 * from the main app partway leaves the earlier flags ruled, and the error names which went through.
 */
const decideFlags: Actions[string] = async (event) => {
  const form = await event.request.formData();
  const modelId = Number(form.get('modelId'));
  let parsed: FlagRef[] | null = null;
  try {
    const result = z
      .array(flagRefSchema)
      .min(1)
      .max(3)
      .safeParse(JSON.parse(String(form.get('flags'))));
    parsed = result.success ? result.data : null;
  } catch {
    parsed = null;
  }
  if (!(modelId > 0) || !parsed) return fail(400, { error: 'Missing model id or flags.' });
  const flags = parsed;
  const refusal = (error: string, partial = false) =>
    fail(400, { error, modelId, subject: modelSubject(modelId), partial });

  if (new Set(flags.map(flagRefId)).size !== flags.length)
    return refusal('A flag is listed twice.');
  const keep = parseKeptIds(form.get('keep'), flags);
  if (!keep) return refusal('Pick a decision.');
  for (const flag of flags) {
    if (flag.source === 'hash' && flag.label !== 'minor')
      return refusal('A hash flag can only be ruled as minor.');
    if (flag.source !== 'hash' && !flag.textHash) return refusal('Missing text hash.');
  }

  const plan = planDecision(flags, keep);
  const input = parseForm(z.object(resolutionReasonFields), form);
  if (typeof input === 'string') return refusal(input);
  const reasons: (RulingReason | null)[] = [];
  for (const flag of plan) {
    const ruling = flagRuling(flag);
    if (!ruling) {
      reasons.push(null);
      continue;
    }
    const picked = {
      resolvedReason: decisionReasonFor(plan, flag, input.resolvedReason ?? ''),
      internalNotes: input.internalNotes,
    };
    const reason = withRuling(ruling, (subject, verdict) =>
      checkedResolutionReason(subject, verdict, picked, [flag.label])
    );
    if (typeof reason === 'string')
      return refusal(plan.length > 1 ? `${flagName(flag)}: ${reason}` : reason);
    reasons.push(reason);
  }

  // One at a time, in the row's order: each is its own main-app ruling, and a failure must not
  // stop the moderator from seeing which ones landed. A throw counts as that flag's failure: letting
  // it escape would hide the flags already ruled.
  //
  // Order is load-bearing for a held re-detection on the same label as a hash flag (both minor): the
  // main app's hash confirm/revert stamps the minor entry and strips its `redetected` marker, so a
  // re-detection ruled after it is refused as stale although the flag was ruled. Ruling the
  // re-detection first finds the model already minor and closes it, then the hash ruling lands.
  // Neither path records the bar's reason for that pair until the hash endpoints take one (P6).
  // Every other flag keeps the row's order (minor before real person, hash before text scan).
  const hashLabels = new Set(plan.filter((f) => f.source === 'hash').map((f) => f.label));
  const first = (f: PlannedFlag) => f.source === 'redetected' && hashLabels.has(f.label);
  const order = [...plan.keys()].sort((a, b) => Number(first(plan[b])) - Number(first(plan[a])));
  const outcomes = [];
  for (const i of order) {
    const flag = plan[i];
    const result = await ruleFlag(modelId, flag, flag.keep, reasons[i]).catch(
      (err: unknown): { ok: false; error: string } => {
        console.error('Flagged decision failed', { modelId, flag: flagRefId(flag) }, err);
        return { ok: false, error: err instanceof Error ? err.message : 'Action failed.' };
      }
    );
    outcomes.push({ flag, result });
  }

  const failed = outcomes.filter((o) => !o.result.ok);
  if (failed.length) {
    const done = outcomes.filter((o) => o.result.ok);
    const message = [
      ...failed.map((o) =>
        `${flagName(o.flag)} not ruled: ${o.result.ok ? '' : o.result.error}`.replace(
          /([^.])$/,
          '$1.'
        )
      ),
      ...done.map((o) => `${flagName(o.flag)} ${o.flag.keep ? 'kept' : 'reverted'}.`),
    ].join(' ');
    return refusal(message, done.length > 0);
  }
  const resolved = outcomes.map((o) => (o.result.ok ? o.result.resolved : ''));
  return {
    success: true,
    modelId,
    // "closed" means the main app found nothing left to do; say so only when that holds for all.
    resolved: resolved.every((r) => r === 'closed') ? 'closed' : resolved[0],
  };
};

/** Keep or lift a flag from the Flagged tab, whatever raised it; or decide every flag on the row. */
export const flaggedActions: Actions = {
  keepFlag: flaggedAction(true),
  liftFlag: flaggedAction(false),
  decideFlags,
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
