import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  DraftConflictError,
  discardWorkingCopy,
  getVisibleDraft,
  getWorkingCopy,
  proposeWorkingCopy,
  saveWorkingCopy,
  updateDraft,
  validateDraftPrompts,
  type DraftPrompts,
  type PromptDraft,
} from '$lib/server/text-scan-lab/drafts.service';
import { LabError, refused } from '$lib/server/text-scan-lab/errors';
import {
  LabHarnessError,
  composeEntities,
  getPrompts,
  scanTexts,
} from '$lib/server/text-scan-lab/harness-client';
import {
  draftIdField,
  draftPromptsField,
  draftRunTotals,
  expectedUpdatedAtField,
  publishDraft,
  publishSchema,
  WORKING_CONFLICT,
} from '$lib/server/text-scan-lab/publish';
import { confirmRequest } from '$lib/server/text-scan-lab/confirm';
import {
  casesPerSecond,
  getRunOutcome,
  prepareRerun,
  prepareRun,
  type TestRun,
} from '$lib/server/text-scan-lab/runs.service';
import { dbRead } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import { purgeDeletedSources } from '$lib/server/text-scan-lab/purge.service';
import { getCase, getCases, listSets } from '$lib/server/text-scan-lab/test-sets.service';
import { userIdByUsername } from '$lib/server/users.service';
import { casePreview, caseTitle } from '$lib/text-scan-lab/case-view';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { estimateSeconds } from '$lib/text-scan-lab/estimate';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { summariseRuns, type RunSummary } from '$lib/text-scan-lab/run-summary';
import { ENTITY_TYPE_NAMES } from '$lib/text-scan-lab/labels';
import {
  DEFAULT_HEADING,
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type Expected,
  type LabEntityType,
  type LabLabel,
  type LabField,
  type LabScanResult,
  type LabText,
  type PromptKey,
} from '$lib/text-scan-lab/types';

const TEST_SETS_PATH = '/text-scan/test-sets';

const querySchema = z.object({
  draft: z.coerce.number().int().positive().optional().catch(undefined),
  set: z.coerce.number().int().positive().optional().catch(undefined),
  case: z.coerce.number().int().positive().optional().catch(undefined),
});

/**
 * The prompt changes the page tests: the moderator's own working copy (none until the first edit), or a
 * proposed draft opened with `?draft=`, editable only by its author until published.
 */
export type ChangesSource =
  | { kind: 'mine'; draft: PromptDraft | null }
  | { kind: 'draft'; draft: PromptDraft; editable: boolean };

type ActivePrompts =
  | { ok: true; content: Partial<Record<PromptKey, string>> }
  | { ok: false; error: string };

export const load: PageServerLoad = async ({ url, locals }) => {
  const q = parseQuery(url, querySchema);
  const me = locals.user.id;
  const canUseSets = canAccess(locals.user, TEST_SETS_PATH);
  const [sets, active, mine, viewed] = await Promise.all([
    canUseSets ? listSets() : [],
    getPrompts().then(
      (p): ActivePrompts => ({
        ok: true,
        content: Object.fromEntries(
          PROMPT_KEYS.filter((k) => p.active[k]).map((k) => [k, p.active[k].content])
        ),
      }),
      (e: unknown): ActivePrompts => ({
        ok: false,
        error: `Could not load the current prompts: ${
          e instanceof LabHarnessError ? e.message : 'unexpected error'
        }`,
      })
    ),
    getWorkingCopy(me),
    q.draft ? getVisibleDraft(q.draft, me) : null,
  ]);

  const changes: ChangesSource =
    viewed && viewed.kind === 'proposed'
      ? {
          kind: 'draft',
          draft: viewed,
          editable: viewed.createdBy === me && !viewed.publishedAt,
        }
      : { kind: 'mine', draft: mine };
  const draftNotice = q.draft && !viewed ? `Draft ${q.draft} not found.` : null;
  const runTotals =
    changes.draft && locals.grants['textScan.prompt.publish'] && canUseSets
      ? await draftRunTotals(changes.draft.id)
      : [];

  return {
    testSets: sets.map((s) => ({ id: s.id, name: s.name, caseCount: s.caseCount })),
    canSaveCase: canUseSets && !!locals.grants['textScan.testSet.edit'],
    active,
    changes,
    workingCopy: mine,
    draftNotice,
    runTotals,
    openCase: q.set && q.case && canUseSets ? { setId: q.set, caseId: q.case } : null,
    wide: true,
  };
};

const PROFILE_TYPES = ['UserProfile', 'User'] as const satisfies readonly LabEntityType[];

const checkSchema = z.object({
  input: z.string().max(200_000, 'That text is too long to judge.'),
  lookupAs: z.enum(LAB_ENTITY_TYPES).catch('Model'),
  judgeAs: z.enum(LAB_ENTITY_TYPES).catch('CommentV2'),
  profileAs: z.enum(PROFILE_TYPES).catch('UserProfile'),
  overrides: draftPromptsField.optional().default({}),
});

type CheckSubject = {
  key: string;
  title: string;
  fields: LabField[];
  entityId: number | null;
  authorId: number | null;
  sourceIds?: number[];
};
type Skipped = { entityId: number; error: string };
type Plan = {
  entityType: LabEntityType;
  subjects: CheckSubject[];
  skipped: Skipped[];
  notice: string | null;
};

/**
 * `changed` is the same text scanned with the moderator's changes, when there are any. `fromCase` is
 * set when the text is a test case's snapshot, whose expectation the verdicts are checked against.
 */
export type CheckItemResult = CheckSubject & {
  current: LabScanResult;
  changed: LabScanResult | null;
  fromCase: { setId: number; caseId: number; expected: Expected } | null;
};

export type CheckResult = {
  checked: true;
  entityType: LabEntityType;
  labels: readonly LabLabel[];
  notice: string | null;
  items: CheckItemResult[];
  skipped: Skipped[];
};

const textPlan = (
  entityType: LabEntityType,
  text: string,
  notice: string | null
): Plan | string => {
  const fields = normaliseLabFields([{ heading: DEFAULT_HEADING[entityType], text }]);
  if (typeof fields === 'string') return fields;
  return {
    entityType,
    subjects: [{ key: 'text', title: 'Your text', fields, entityId: null, authorId: null }],
    skipped: [],
    notice,
  };
};

async function entityPlan(
  entityType: LabEntityType,
  ids: number[],
  title: (id: number) => string
): Promise<Plan> {
  const subjects: CheckSubject[] = [];
  const skipped: Skipped[] = [];
  for (const c of await composeEntities(entityType, ids)) {
    if (c.ok)
      subjects.push({
        key: String(c.entityId),
        title: title(c.entityId),
        fields: c.fields,
        entityId: c.entityId,
        authorId: c.userId,
        sourceIds: c.sourceIds,
      });
    else skipped.push({ entityId: c.entityId, error: c.error });
  }
  return { entityType, subjects, skipped, notice: null };
}

async function plan(input: z.infer<typeof checkSchema>): Promise<Plan | string> {
  const parsed = parseCheckInput(input.input);
  const named = (type: LabEntityType) => (id: number) => `${ENTITY_TYPE_NAMES[type]} ${id}`;
  switch (parsed.kind) {
    case 'empty':
      return 'Paste a Civitai link, an id, or some text.';
    case 'too-many-ids':
      return `${parsed.count} ids is more than the ${parsed.max} one check can take.`;
    case 'ids':
      return entityPlan(input.lookupAs, parsed.ids, named(input.lookupAs));
    case 'entity':
      return entityPlan(parsed.entityType, parsed.ids, named(parsed.entityType));
    case 'user': {
      const userId = await userIdByUsername(parsed.username);
      if (userId === null) return `No user called "${parsed.username}".`;
      const type = input.profileAs;
      return entityPlan(type, [userId], () => `${ENTITY_TYPE_NAMES[type]} · ${parsed.username}`);
    }
    case 'text':
      return textPlan(input.judgeAs, parsed.text, null);
    case 'unknown-url':
      return textPlan(input.judgeAs, parsed.text, parsed.notice);
    case 'refused':
      return parsed.notice;
  }
}

const missing = (key: string): LabScanResult => ({
  key,
  ok: false,
  error: 'No result returned for this item.',
});

async function scanSubjects(
  entityType: LabEntityType,
  subjects: CheckSubject[],
  overrides: DraftPrompts
): Promise<CheckItemResult[]> {
  const texts: LabText[] = subjects.map(({ key, fields }) => ({ key, fields }));
  const withChanges = Object.keys(overrides).length > 0;
  const [current, changed] = await Promise.allSettled([
    scanTexts(entityType, texts),
    withChanges
      ? scanTexts(entityType, texts, overrides as Record<string, string>)
      : Promise.resolve(null),
  ]);
  if (current.status === 'rejected') throw current.reason;
  // A refused changed run (say, an override the harness will not take) still leaves the current
  // verdicts worth showing; each item carries the refusal instead.
  let changedByKey: Map<string, LabScanResult> | null = null;
  let changedRefusal: string | null = null;
  if (changed.status === 'rejected') {
    if (!(changed.reason instanceof LabError)) throw changed.reason;
    changedRefusal = changed.reason.message;
  } else if (changed.value) {
    changedByKey = new Map(changed.value.map((r) => [r.key, r] as const));
  }
  const currentByKey = new Map(current.value.map((r) => [r.key, r] as const));

  return subjects.map((s) => ({
    ...s,
    current: currentByKey.get(s.key) ?? missing(s.key),
    changed: !withChanges
      ? null
      : changedRefusal !== null
      ? { key: s.key, ok: false, error: changedRefusal }
      : changedByKey?.get(s.key) ?? missing(s.key),
    fromCase: null,
  }));
}

function checkOverrides(raw: Record<string, unknown>): DraftPrompts | ReturnType<typeof fail> {
  try {
    return validateDraftPrompts(raw);
  } catch (e) {
    return refused(e);
  }
}

const isFailure = (v: unknown): v is ReturnType<typeof fail> =>
  typeof v === 'object' && v !== null && 'status' in v && 'data' in v;

export type SetRunSide = {
  runId: number;
  status: TestRun['status'];
  errors: { caseId: number; error: string }[];
};

export type SetRunView = {
  setRun: true;
  setId: number;
  current: SetRunSide;
  changed: SetRunSide | null;
  summary: RunSummary;
  cases: Record<
    number,
    { entityType: LabEntityType; entityId: number | null; preview: string | null }
  >;
};

/** A set run just started. `changedError`: why the run with changes did not start, when Current did. */
export type SetRunStarted = {
  started: true;
  setId: number;
  currentRunId: number;
  changedRunId: number | null;
  changedError: string | null;
};

async function setRunView(
  setId: number,
  currentRunId: number,
  changedRunId: number | null
): Promise<SetRunView> {
  const [current, changed] = await Promise.all([
    getRunOutcome(setId, currentRunId),
    changedRunId === null ? null : getRunOutcome(setId, changedRunId),
  ]);
  const summary = summariseRuns(current.rows, changed?.rows ?? null);
  const listed = new Set(
    [...summary.fixed, ...summary.broke, ...current.errors, ...(changed?.errors ?? [])].map(
      (c) => c.caseId
    )
  );
  const cases: SetRunView['cases'] = {};
  for (const c of await listCasesById(setId, listed)) cases[c.id] = c;
  const side = (o: typeof current): SetRunSide => ({
    runId: o.run.id,
    status: o.run.status,
    errors: o.errors,
  });
  return {
    setRun: true,
    setId,
    current: side(current),
    changed: changed ? side(changed) : null,
    summary,
    cases,
  };
}

async function listCasesById(setId: number, ids: Set<number>) {
  if (!ids.size) return [];
  const cases = await getCases(setId, [...ids]);
  return cases.map((c) => ({
    id: c.id,
    entityType: c.entityType,
    entityId: c.entityId,
    preview: casePreview(c.fields),
  }));
}

const setIdField = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optionalRunId = z
  .string()
  .optional()
  .transform((v) => (v ? Number(v) : null))
  .refine((v) => v === null || (Number.isSafeInteger(v) && v > 0), 'Invalid run.');

const noSetAccess = () => fail(403, { error: 'You do not have access to test sets.' });

const nullableExpected = z
  .literal('')
  .transform(() => null)
  .or(expectedUpdatedAtField);

export const actions: Actions = {
  check: async ({ request }) => {
    const input = parseForm(checkSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const overrides = checkOverrides(input.overrides);
    if (isFailure(overrides)) return overrides;

    let planned: Plan | string;
    try {
      planned = await plan(input);
    } catch (e) {
      return refused(e);
    }
    if (typeof planned === 'string') return fail(400, { error: planned });
    const { entityType, subjects, skipped, notice } = planned;
    if (!subjects.length)
      return fail(400, {
        error: `Nothing to check: ${skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.`,
      });

    let items: CheckItemResult[];
    try {
      items = await scanSubjects(entityType, subjects, overrides);
    } catch (e) {
      return refused(e);
    }
    return {
      checked: true,
      entityType,
      labels: LAB_LABELS[entityType],
      notice,
      items,
      skipped,
    } satisfies CheckResult;
  },

  checkCase: async ({ request, locals }) => {
    if (!canAccess(locals.user, TEST_SETS_PATH)) return noSetAccess();
    const input = parseForm(
      z.object({
        setId: setIdField,
        caseId: setIdField,
        overrides: draftPromptsField.optional().default({}),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const overrides = checkOverrides(input.overrides);
    if (isFailure(overrides)) return overrides;

    // A deep link can reach a case before any list purged it.
    await purgeDeletedSources({ moderator: getModeratorDb(), main: dbRead }, input.setId);
    const found = await getCase(input.setId, input.caseId);
    if (!found) return fail(404, { error: 'That test case is no longer in this set.' });
    if (!found.fields || found.sourceDeletedAt)
      return fail(400, { error: "This case's text was removed when its source was deleted." });
    const subject: CheckSubject = {
      key: `case-${found.id}`,
      title: `Test case · ${caseTitle(found.entityType, found.entityId)}`,
      fields: found.fields,
      entityId: found.entityId,
      authorId: found.authorId,
      sourceIds: found.sourceIds,
    };
    try {
      const [item] = await scanSubjects(found.entityType, [subject], overrides);
      return {
        checked: true,
        entityType: found.entityType,
        labels: LAB_LABELS[found.entityType],
        notice: null,
        items: [
          { ...item, fromCase: { setId: input.setId, caseId: found.id, expected: found.expected } },
        ],
        skipped: [],
      } satisfies CheckResult;
    } catch (e) {
      return refused(e);
    }
  },

  /**
   * Starts a whole set with the current prompts and, given `draftId` (my saved changes, or the draft
   * being viewed), with those too. Both are ordinary runs, listed on the set's page. They scan after
   * the response: the page follows them by run id, then asks for `setRunSummary`.
   */
  runSet: async ({ request, locals }) => {
    if (!canAccess(locals.user, TEST_SETS_PATH)) return noSetAccess();
    const form = await request.formData();
    const input = parseForm(
      z.object({ setId: setIdField, draftId: draftIdField.optional() }),
      form
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const me = locals.user.id;
    try {
      const current = await prepareRun({ setId: input.setId, version: 'active' }, me);
      const changed =
        input.draftId === undefined
          ? null
          : await prepareRun({ setId: input.setId, version: input.draftId }, me);
      // The two runs scan side by side, so the pair takes about as long as one.
      const ask = await confirmRequest(
        form,
        { ...current, stamp: [current.stamp, changed?.stamp].join('|') },
        async () => estimateSeconds(current.count, await casesPerSecond(input.setId))
      );
      if (ask) return ask;

      const [a, b] = await Promise.allSettled([current.execute(me), changed?.execute(me) ?? null]);
      if (a.status === 'rejected') throw a.reason;
      let changedError: string | null = null;
      if (b.status === 'rejected') {
        if (!(b.reason instanceof LabError)) throw b.reason;
        changedError = b.reason.message;
      }
      return {
        started: true,
        setId: input.setId,
        currentRunId: a.value.run.id,
        changedRunId: b.status === 'fulfilled' ? b.value?.run.id ?? null : null,
        changedError,
      } satisfies SetRunStarted;
    } catch (e) {
      return refused(e);
    }
  },

  rerunSetErrors: async ({ request, locals }) => {
    if (!canAccess(locals.user, TEST_SETS_PATH)) return noSetAccess();
    const form = await request.formData();
    const input = parseForm(
      z.object({
        setId: setIdField,
        runId: setIdField,
        currentRunId: setIdField,
        changedRunId: optionalRunId,
      }),
      form
    );
    if (typeof input === 'string') return fail(400, { error: input });
    if (input.runId !== input.currentRunId && input.runId !== input.changedRunId)
      return fail(400, { error: 'That run is not part of this set run.' });
    try {
      const planned = await prepareRerun(input.setId, input.runId, locals.user.id);
      const ask = await confirmRequest(form, planned, async () =>
        estimateSeconds(planned.count, await casesPerSecond(input.setId))
      );
      if (ask) return ask;
      await planned.execute(locals.user.id);
      return {
        started: true,
        setId: input.setId,
        currentRunId: input.currentRunId,
        changedRunId: input.changedRunId,
        changedError: null,
      } satisfies SetRunStarted;
    } catch (e) {
      return refused(e);
    }
  },

  setRunSummary: async ({ request, locals }) => {
    if (!canAccess(locals.user, TEST_SETS_PATH)) return noSetAccess();
    const input = parseForm(
      z.object({ setId: setIdField, currentRunId: setIdField, changedRunId: optionalRunId }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      return await setRunView(input.setId, input.currentRunId, input.changedRunId);
    } catch (e) {
      return refused(e);
    }
  },

  /**
   * Autosave. Without `draftId` it saves the moderator's working copy; with one, a proposed draft its
   * author opened in Check. `expectedUpdatedAt` is empty when no working copy existed yet.
   */
  saveChanges: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        prompts: draftPromptsField,
        expectedUpdatedAt: nullableExpected,
        draftId: draftIdField.optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const me = locals.user.id;
    try {
      let saved: PromptDraft | null;
      if (input.draftId !== undefined) {
        const draft = await getVisibleDraft(input.draftId, me);
        if (!draft || draft.kind !== 'proposed')
          return fail(404, { error: `Draft ${input.draftId} not found.` });
        if (draft.createdBy !== me)
          return fail(403, { error: 'Only the author of a draft can change it here.' });
        if (!input.expectedUpdatedAt) return fail(400, { error: 'Missing version of the draft.' });
        saved = await updateDraft(
          draft.id,
          { prompts: input.prompts, note: draft.note, expectedUpdatedAt: input.expectedUpdatedAt },
          me
        );
      } else {
        saved = await saveWorkingCopy(me, input.prompts, input.expectedUpdatedAt);
      }
      return {
        draftId: saved?.id ?? null,
        updatedAt: saved?.updatedAt.toISOString() ?? null,
      };
    } catch (e) {
      if (e instanceof DraftConflictError)
        return fail(409, { error: input.draftId === undefined ? WORKING_CONFLICT : e.message });
      return refused(e);
    }
  },

  discardChanges: async ({ locals }) => {
    await discardWorkingCopy(locals.user.id);
    return { success: true };
  },

  proposeChanges: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        name: z.string(),
        note: z.string().optional().default(''),
        expectedUpdatedAt: expectedUpdatedAtField,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const draft = await proposeWorkingCopy(
        locals.user.id,
        input.name,
        input.note,
        input.expectedUpdatedAt
      );
      return { draftId: draft.id, name: draft.name };
    } catch (e) {
      if (e instanceof DraftConflictError) return fail(409, { error: WORKING_CONFLICT });
      return refused(e);
    }
  },

  publish: requiresGrant('textScan.prompt.publish', async ({ request, locals }) => {
    const input = parseForm(publishSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    return publishDraft(input, locals.user.id);
  }),
};
