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
import { listSets } from '$lib/server/text-scan-lab/test-sets.service';
import { userIdByUsername } from '$lib/server/users.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import {
  ENTITY_TYPE_NAMES,
  blankPromptKeys,
  describeBlankPrompts,
} from '$lib/text-scan-lab/labels';
import {
  DEFAULT_HEADING,
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type LabEntityType,
  type LabField,
  type LabScanResult,
  type LabText,
  type PromptKey,
} from '$lib/text-scan-lab/types';

const querySchema = z.object({
  draft: z.coerce.number().int().positive().optional().catch(undefined),
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
  // Saving posts to the set page's action, which the page grant gates as well.
  const canSave =
    locals.grants['textScan.testSet.edit'] && canAccess(locals.user, '/text-scan/test-sets');
  const [sets, active, mine, viewed] = await Promise.all([
    canSave ? listSets() : [],
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
    changes.draft &&
    locals.grants['textScan.prompt.publish'] &&
    canAccess(locals.user, '/text-scan/test-sets')
      ? await draftRunTotals(changes.draft.id)
      : [];

  return {
    testSets: sets.map((s) => ({ id: s.id, name: s.name })),
    active,
    changes,
    workingCopy: mine,
    draftNotice,
    runTotals,
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
};
type Skipped = { entityId: number; error: string };
type Plan = {
  entityType: LabEntityType;
  subjects: CheckSubject[];
  skipped: Skipped[];
  notice: string | null;
};

/** `changed` is the same text scanned with the moderator's changes, when there are any. */
export type CheckItemResult = CheckSubject & {
  current: LabScanResult;
  changed: LabScanResult | null;
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
      });
    else skipped.push({ entityId: c.entityId, error: c.error });
  }
  return { entityType, subjects, skipped, notice: null };
}

/** What to scan, or a refusal to show. Everything here runs before any scan is submitted. */
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

const nullableExpected = z.literal('').transform(() => null).or(expectedUpdatedAtField);

export const actions: Actions = {
  check: async ({ request }) => {
    const input = parseForm(checkSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const blank = blankPromptKeys(input.overrides);
    if (blank.length) return fail(400, { error: describeBlankPrompts(blank) });
    let overrides: DraftPrompts;
    try {
      overrides = validateDraftPrompts(input.overrides);
    } catch (e) {
      return refused(e);
    }

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

    const texts: LabText[] = subjects.map(({ key, fields }) => ({ key, fields }));
    const withChanges = Object.keys(overrides).length > 0;
    const [current, changed] = await Promise.allSettled([
      scanTexts(entityType, texts),
      withChanges
        ? scanTexts(entityType, texts, overrides as Record<string, string>)
        : Promise.resolve(null),
    ]);
    if (current.status === 'rejected') return refused(current.reason);
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

    const items: CheckItemResult[] = subjects.map((s) => ({
      ...s,
      current: currentByKey.get(s.key) ?? missing(s.key),
      changed: !withChanges
        ? null
        : changedRefusal !== null
        ? { key: s.key, ok: false, error: changedRefusal }
        : changedByKey?.get(s.key) ?? missing(s.key),
    }));
    return {
      checked: true as const,
      entityType,
      labels: LAB_LABELS[entityType],
      notice,
      items,
      skipped,
    };
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
    const blank = blankPromptKeys(input.prompts);
    if (blank.length) return fail(400, { error: describeBlankPrompts(blank) });
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
