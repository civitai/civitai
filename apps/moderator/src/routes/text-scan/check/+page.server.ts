import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import { LabError, refused } from '$lib/server/text-scan-lab/errors';
import {
  FREE_TEXT_KEY,
  LabHarnessError,
  composeEntities,
  getPrompts,
  scanTexts,
} from '$lib/server/text-scan-lab/harness-client';
import {
  promptChangesField,
  publishChanges,
  publishSchema,
  validatePromptChanges,
} from '$lib/server/text-scan-lab/publish';
import { userIdByUsername } from '$lib/server/users.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { ENTITY_TYPE_NAMES } from '$lib/text-scan-lab/labels';
import {
  DEFAULT_HEADING,
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  type LabEntityType,
  type LabLabel,
  type LabField,
  type LabScanResult,
  type LabText,
  type PromptChanges,
  type PromptKey,
} from '$lib/text-scan-lab/types';

/** The current prompts: their text, and each version's id, which a publish checks is still current. */
export type ActivePrompts =
  | {
      ok: true;
      content: Partial<Record<PromptKey, string>>;
      ids: Partial<Record<PromptKey, number>>;
    }
  | { ok: false; error: string };

export const load: PageServerLoad = async () => {
  const active = await getPrompts().then(
    (p): ActivePrompts => {
      const keys = PROMPT_KEYS.filter((k) => p.active[k]);
      return {
        ok: true,
        content: Object.fromEntries(keys.map((k) => [k, p.active[k].content])),
        ids: Object.fromEntries(keys.map((k) => [k, p.active[k].id])),
      };
    },
    (e: unknown): ActivePrompts => ({
      ok: false,
      error: `Could not load the current prompts: ${
        e instanceof LabHarnessError ? e.message : 'unexpected error'
      }`,
    })
  );
  return { active, wide: true };
};

const PROFILE_TYPES = ['UserProfile', 'User'] as const satisfies readonly LabEntityType[];

const checkSchema = z.object({
  input: z.string().max(200_000, 'That text is too long to judge.'),
  lookupAs: z.enum(LAB_ENTITY_TYPES).catch('Model'),
  judgeAs: z.enum(LAB_ENTITY_TYPES).catch('CommentV2'),
  profileAs: z.enum(PROFILE_TYPES).catch('UserProfile'),
  overrides: promptChangesField.optional().default({}),
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
    subjects: [{ key: FREE_TEXT_KEY, title: 'Your text', fields, entityId: null, authorId: null }],
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
  overrides: PromptChanges
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
  }));
}

function checkOverrides(raw: Record<string, unknown>): PromptChanges | ReturnType<typeof fail> {
  try {
    return validatePromptChanges(raw);
  } catch (e) {
    return refused(e);
  }
}

const isFailure = (v: unknown): v is ReturnType<typeof fail> =>
  typeof v === 'object' && v !== null && 'status' in v && 'data' in v;

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

  publish: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(publishSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    return publishChanges(input);
  }),
};
