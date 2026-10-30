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
  appealRuling,
  routesThroughAppeal,
  type FlagRef,
  withRuling,
} from '$lib/minor-flags/flagged-decision';
import {
  getHeldDetectionModelCount,
  getMinorFlagAppealGroups,
  getMinorFlagAppealsForReview,
  getMinorQueueCounts,
  getFlaggedModels,
  getFlaggedSourceCounts,
  getModelAppealState,
  getModelFlagDetail,
  getModelFlagState,
  getNeedsReviewCount,
  getNeedsReviewModels,
  type MinorSearch,
} from '$lib/server/minor-hash.service';
import {
  DEFAULT_NEEDS_REVIEW_FILTERS,
  NEEDS_REVIEW_PERMISSIONS,
  NEEDS_REVIEW_SOURCE_FILTERS,
  needsReviewBranches,
  needsReviewChipCounts,
  needsReviewSources,
  needsReviewTotal,
  type ChipCounts,
  type NeedsReviewFilters,
  type NeedsReviewSourceFilter,
  type NeedsReviewSources,
} from '$lib/minor-flags/needs-review';
import { denied, type PermissionSet } from '$lib/permissions';
import { canAccess } from '$lib/server/access';
import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
import type { FlaggedLabel, FlaggedSource } from '$lib/minor-flags/flagged-decision';
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
import { ruleFlagAppeal, type FlagAppealDecision } from '$lib/server/minor-flag-appeal-ruling';
import { MAX_INT4 } from '$lib/server/users.service';
import { bounded } from '$lib/server/bounded';
import {
  confirmMinorFlag,
  confirmPoiFlag,
  dismissMinorHashMatch,
  dismissPoiHashMatch,
  resolveMinorFlagAppeal,
  resolveMinorFlagAppealPerLabel,
  resolveRedetection,
  revertMinorFlag,
  revertPoiFlag,
  ruleTextScanFlag,
  setModelMinorFlag,
  setModelPoiFlag,
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

const needsReviewFilterSchema = z.object({
  source: z.enum(NEEDS_REVIEW_SOURCE_FILTERS).catch(DEFAULT_NEEDS_REVIEW_FILTERS.source),
  flag: z.enum(FLAGGED_FLAGS).catch(DEFAULT_NEEDS_REVIEW_FILTERS.flag),
  sort: z.enum(FLAGGED_SORTS).catch(DEFAULT_NEEDS_REVIEW_FILTERS.sort),
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
    : { text: q };
  return { limit, page, q, offset: (page - 1) * limit, search };
}

/**
 * A count that costs seconds cold (the file-match set) is decoration on the list: past this budget the
 * footer drops "of N" instead of holding the page.
 *
 * ⚠️ Offset paging over a queue moderators are draining SKIPS rows: action a row on page 1 and every
 * later row shifts up one, so page 2 starts past something never seen. The shell's "Refresh queue"
 * re-cuts the page after acting.
 */
const TOTAL_BUDGET_MS = 1_000;

const withinBudget = async <T>(work: () => Promise<T>, what: string) =>
  (await bounded(work, TOTAL_BUDGET_MS, (err) => console.error(`${what} failed`, err))) ??
  undefined;

/** Needs review's "of N" and source chip counts. With file matches in play they come from the cached
 *  file-match counts and the cheap held-detection count, so they are offered only for the unsearched,
 *  unfiltered-by-label queue; held detections alone are cheap to count exactly. */
async function needsReviewCounts(
  sources: NeedsReviewSources,
  use: NeedsReviewSources,
  search: MinorSearch | undefined,
  filters: NeedsReviewFilters
): Promise<{ total: number | undefined; chipCounts: ChipCounts<NeedsReviewSourceFilter> }> {
  if (search || filters.flag !== 'all') {
    // A label filter or search leaves the cached parts behind; only a detections-only list counts.
    const total = use.matches
      ? undefined
      : await withinBudget(
          () => getNeedsReviewCount({ search, filters, sources: use }),
          'Needs review total'
        );
    return { total, chipCounts: {} };
  }
  const [matches, detections] = await Promise.all([
    sources.matches ? withinBudget(getMinorQueueCounts, 'File matches total') : undefined,
    sources.detections
      ? withinBudget(getHeldDetectionModelCount, 'Held detections total')
      : undefined,
  ]);
  const parts = {
    detections: detections ?? null,
    matches: matches?.pending ?? null,
    overlap: matches?.pendingWithDetection ?? null,
  };
  return {
    total: needsReviewTotal(use, parts) ?? undefined,
    chipCounts: needsReviewChipCounts(sources, parts),
  };
}

/** Needs review lists only the kinds of lead the viewer may rule; `sources` tells the page which. */
export async function loadNeedsReviewQueue(url: URL, grants: PermissionSet) {
  const { limit, page, q, offset, search } = parsePaging(url);
  const needsReviewFilters: NeedsReviewFilters = parseQuery(url, needsReviewFilterSchema);
  const sources = needsReviewSources(grants);
  const use = needsReviewBranches(sources, needsReviewFilters);
  const [queue, { total, chipCounts }] = await Promise.all([
    getNeedsReviewModels({ limit, offset, search, filters: needsReviewFilters, sources }),
    needsReviewCounts(sources, use, search, needsReviewFilters),
  ]);
  return {
    limit,
    page,
    offset,
    q,
    needsReviewFilters,
    sources,
    total,
    chipCounts,
    ...queue,
    fullBleed: true,
  };
}

export type NeedsReviewQueueData = Awaited<ReturnType<typeof loadNeedsReviewQueue>>;

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
  const [queue, chipCounts] = await Promise.all([
    getFlaggedModels({ limit, offset, search, filters: flaggedFilters }),
    // The footer's "of N" and the chip counts are decoration; a failure here must not take the list
    // down with it. One pass counts every source, at the cost of the All count.
    getFlaggedSourceCounts({ search, flag: flaggedFilters.flag }).catch((err) => {
      console.error('Flagged counts failed', err);
      return undefined;
    }),
  ]);
  const total = chipCounts?.[flaggedFilters.source];
  return {
    limit,
    page,
    offset,
    q,
    flaggedFilters,
    total,
    chipCounts: chipCounts ?? {},
    ...queue,
    fullBleed: true,
  };
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

type RulingReason = { resolvedReason: string; internalNotes: string | undefined };

/** The keep and lift of each label's hash flag and file match (no reason yet). */
const hashRuling = (source: 'hash' | 'file-match', label: FlaggedLabel, keep: boolean) => {
  // Only the picked endpoint is read: reading every import, as a table would, breaks the hand-listed
  // mocks of minor-flag.service in the route tests.
  if (source === 'hash')
    return label === 'poi'
      ? keep
        ? confirmPoiFlag
        : revertPoiFlag
      : keep
      ? confirmMinorFlag
      : revertMinorFlag;
  if (label === 'poi') return keep ? setModelPoiFlag : dismissPoiHashMatch;
  return keep ? setModelMinorFlag : dismissMinorHashMatch;
};

/** Rules one flag through the path its source owns: hash flags through the main app's confirm and
 *  revert endpoints, text-scan flags through `ruleTextScanFlag`, re-detections through
 *  `resolveRedetection`, file matches through the label's set and dismiss (`hashRuling`). The caller
 *  has checked the label, text hash and reason. */
async function ruleFlag(
  modelId: number,
  flag: FlagRef,
  keep: boolean,
  reason: RulingReason | null
): Promise<{ ok: true; resolved: string } | { ok: false; error: string }> {
  if (flag.source === 'hash' || flag.source === 'file-match') {
    const result = await hashRuling(flag.source, flag.label, keep)(modelId);
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
    // Auto-flagged's sources only: held detections are ruled from Needs review, under its permission.
    const source = z.enum(['hash', 'text-scan']).safeParse(form.get('source'));
    if (!(modelId > 0) || !source.success)
      return fail(400, { error: 'Missing model id, label or source.' });
    const refusal = (error: string) =>
      fail(400, { error, modelId, subject: modelSubject(modelId) });

    if (source.data === 'hash') {
      // Minor only, as before real-person hash flags existed: this action skips the open-appeal
      // routing `decideFlags` applies, so a real-person hash flag is ruled only through that.
      if (posted !== null && !(label.success && label.data === 'minor'))
        return refusal('A hash flag can only be ruled as minor here.');
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
  source: z.enum(['hash', 'redetected', 'text-scan', 'file-match']),
  textHash: z.string().min(1).max(200).nullable(),
});
const SOURCE_NAMES: Record<FlagRef['source'], string> = {
  hash: 'hash',
  'text-scan': 'text scan',
  redetected: 'held detection',
  'file-match': 'file match',
};
const flagName = (flag: FlagRef) => {
  const name = FLAG_LABEL_NAMES[flag.label];
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (${SOURCE_NAMES[flag.source]})`;
};

/**
 * One decision over every flag (or lead) a row carries: `flags` lists them, the pressed button's `keep`
 * names the ones kept, and every other one is reverted or dismissed. Each is ruled through its own
 * source's path (`ruleFlag`). Only `sources` are accepted, and `refuse` may refuse a flag (a permission
 * the viewer lacks). Every check runs before the first write, so a refusal changes nothing; a failure
 * from the main app partway leaves the earlier flags ruled, and the error names which went through.
 */
const decideAction =
  (
    sources: readonly FlaggedSource[],
    refuse: (event: RequestEvent, flag: FlagRef) => string | null = () => null,
    appealAware = false
  ): Actions[string] =>
  async (event) => {
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
    for (const flag of flags) {
      if (!sources.includes(flag.source)) return refusal('This tab does not rule that flag.');
      const refused = refuse(event, flag);
      if (refused) return refusal(refused);
    }
    const keep = parseKeptIds(form.get('keep'), flags);
    if (!keep) return refusal('Pick a decision.');
    for (const flag of flags)
      if ((flag.source === 'text-scan' || flag.source === 'redetected') && !flag.textHash)
        return refusal('Missing text hash.');

    const plan = planDecision(flags, keep);
    const input = parseForm(z.object(resolutionReasonFields), form);
    if (typeof input === 'string') return refusal(input);
    if (appealAware && routesThroughAppeal(flags, true)) {
      const state = await getModelAppealState(modelId);
      if (state.pendingAppeal !== (form.get('hasPendingAppeal') === 'true'))
        return refusal("The owner's appeal changed since you loaded this row — reload.");
      if (state.pendingAppeal) {
        if (!canAccess(event.locals.user, MODEL_FLAGS_APPEALS_PATH))
          return refusal('Rule this from Appeals — you need access to the Appeals tab.');
        return decideThroughAppeal(modelId, plan, state, input, refusal);
      }
    }
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
    // it escape would hide the flags already ruled. A Needs review row lists its held detections before
    // its file matches, so a kept detection lands first and settles its label's match (`flagFileMatch`).
    const outcomes: { flag: PlannedFlagRef; result: RuleResult }[] = [];
    for (const [i, flag] of plan.entries()) {
      const result = await (flag.source === 'file-match' && flag.keep
        ? flagFileMatch(modelId, flag.label, outcomes)
        : ruleFlag(modelId, flag, flag.keep, reasons[i])
      ).catch((err: unknown): { ok: false; error: string } => {
        console.error('Flagged decision failed', { modelId, flag: flagRefId(flag) }, err);
        return { ok: false, error: err instanceof Error ? err.message : 'Action failed.' };
      });
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
        ...done.map((o) => `${flagName(o.flag)} ${doneVerb(o.flag)}.`),
      ].join(' ');
      return refusal(message, done.length > 0);
    }
    const resolved = outcomes.map((o) => (o.result.ok ? o.result.resolved : ''));
    return {
      success: true,
      modelId,
      // "closed" means the main app found nothing left to do; say so only when that holds for all,
      // and otherwise report a lead that was actually ruled.
      resolved: resolved.find((r) => r !== 'closed') ?? 'closed',
    };
  };

type AppealState = Awaited<ReturnType<typeof getModelAppealState>>;

/** Syncs with `ruleModelTextScanFlag` (main app), whose per-flag path this decision replaces under an
 *  appeal; the appeal resolver grants against the last-scanned text and checks neither. */
const staleTextScanFlag = (plan: readonly PlannedFlagRef[], state: AppealState) => {
  for (const flag of plan) {
    if (flag.source !== 'text-scan') continue;
    const entry = state.textScan[flag.label];
    if (entry.textHash !== flag.textHash)
      return 'The text changed since this flag. Reload and review it again.';
    if (entry.redetectedTextHash && entry.redetectedTextHash !== flag.textHash)
      return 'Newer text is held for review on this flag. Rule it from the re-detection queue.';
  }
  return null;
};

/** An Auto-flagged decision while the owner's appeal is open resolves that appeal, as the Appeals tab
 *  does: the main app refuses a per-flag keep past an open appeal. The resolver also rules a label the
 *  row does not list, so a model flagged beyond the row is refused rather than ruled unseen. */
async function decideThroughAppeal(
  modelId: number,
  plan: readonly PlannedFlagRef[],
  state: AppealState,
  input: { resolvedReason?: string; internalNotes?: string },
  refusal: (error: string) => ReturnType<typeof fail>
) {
  const stale = staleTextScanFlag(plan, state);
  if (stale) return refusal(stale);
  const listed = new Set(plan.map((f) => f.label));
  for (const label of ['minor', 'poi'] as const)
    if (state[label] && !listed.has(label))
      return refusal(
        `This model is also flagged as ${FLAG_LABEL_NAMES[label]}, which this row does not list. Rule it from Appeals.`
      );
  const ruling = appealRuling(plan);
  if ('error' in ruling) return refusal(ruling.error);
  const reason = checkedResolutionReason(
    'flagAppeal',
    ruling.verdict,
    input,
    ruling.lifted.length ? ruling.lifted : undefined
  );
  if (typeof reason === 'string') return refusal(reason);

  const result = ruling.perLabel
    ? await resolveMinorFlagAppealPerLabel(modelId, ruling.perLabel, reason)
    : await resolveMinorFlagAppeal(modelId, ruling.verdict === 'Rejected', reason);
  if (!result.ok) return refusal(result.error);
  const resolved = ruling.perLabel ? 'split' : ruling.verdict === 'Rejected' ? 'kept' : 'dismissed';
  return { success: true, modelId, resolved };
}

/** What happened to a ruled flag: an applied flag is kept or reverted; a Needs review lead, which had
 *  nothing applied, is flagged or dismissed. */
const doneVerb = (flag: PlannedFlagRef) =>
  flag.source === 'redetected' || flag.source === 'file-match'
    ? flag.keep
      ? 'flagged'
      : 'dismissed'
    : flag.keep
    ? 'kept'
    : 'reverted';

type PlannedFlagRef = FlagRef & { keep: boolean };
type RuleResult = { ok: true; resolved: string } | { ok: false; error: string };
/**
 * Flags a file match with its label, unless the model carries that flag already. A detection of the
 * label kept earlier in this decision applied the flag itself, so it settles the match, which leaves the
 * queue with it (the queue lists only models without the flag); setting it again would re-run its side
 * effects as a second, moderator-sourced flag. A model flagged for any other reason is refused.
 */
async function flagFileMatch(
  modelId: number,
  label: FlaggedLabel,
  earlier: readonly { flag: PlannedFlagRef; result: RuleResult }[]
): Promise<RuleResult> {
  const state = await getModelFlagState(modelId);
  // flag-match re-checks this under the row lock; refusing here keeps the message specific.
  if (label === 'poi' && !state.poi && !state.poiMatchQueued)
    return {
      ok: false,
      error: 'This real-person match is no longer waiting: someone ruled it. Reload the queue.',
    };
  if (!state[label])
    return ruleFlag(modelId, { label, source: 'file-match', textHash: null }, true, null);
  const appliedHere = earlier.some(
    (o) => o.result.ok && o.flag.keep && o.flag.source === 'redetected' && o.flag.label === label
  );
  return appliedHere
    ? { ok: true, resolved: 'kept' }
    : {
        ok: false,
        error: `This model is already flagged as ${FLAG_LABEL_NAMES[label]}, so the match needs no flag. Dismiss it or reload the queue.`,
      };
}

/** Keep or lift an applied flag from Auto-flagged; or decide every flag on the row. */
export const flaggedActions: Actions = {
  keepFlag: flaggedAction(true),
  liftFlag: flaggedAction(false),
  decideFlags: decideAction(['hash', 'text-scan'], undefined, true),
};

/** The permission each kind of Needs review lead is ruled under (`NEEDS_REVIEW_PERMISSIONS`). */
const NEEDS_REVIEW_PERMISSION_OF = {
  redetected: NEEDS_REVIEW_PERMISSIONS.detections,
  'file-match': NEEDS_REVIEW_PERMISSIONS.matches,
} as const;

/** Flag or dismiss every lead on a Needs review row: held detections and the file match. The page
 *  lists only the kinds the viewer may rule, and this checks again, since a form can post anything. */
export const needsReviewActions: Actions = {
  decideFlags: decideAction(['redetected', 'file-match'], (event, flag) => {
    const id = NEEDS_REVIEW_PERMISSION_OF[flag.source as keyof typeof NEEDS_REVIEW_PERMISSION_OF];
    return event.locals.grants[id] ? null : denied(id);
  }),
};

const reasonFields = z.object(resolutionReasonFields);

/** Rules the appeal for the posted model and answers as the Appeals queue does. */
async function ruleAppealFrom(form: FormData, modelId: number, decision: FlagAppealDecision) {
  const fields = parseForm(reasonFields, form);
  const ruling =
    typeof fields === 'string'
      ? ({ ok: false, error: fields } as const)
      : await ruleFlagAppeal({ modelId, decision, reason: fields });
  if (!ruling.ok)
    return fail(400, { error: ruling.error, modelId, subject: modelSubject(modelId) });
  return { success: true, modelId, rescanQueued: ruling.rescanQueued };
}

const wholeAppealAction =
  (uphold: boolean): Actions[string] =>
  async (event) => {
    const form = await event.request.formData();
    const modelId = Number(form.get('modelId'));
    if (!(modelId > 0)) return fail(400, { error: 'Missing model id.' });
    return ruleAppealFrom(form, modelId, uphold ? 'uphold' : 'overturn');
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
    return ruleAppealFrom(form, modelId, { minor: minor.data, poi: poi.data });
  },
};
