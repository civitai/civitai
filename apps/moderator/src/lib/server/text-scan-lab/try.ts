import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import {
  MODEL_RULE_LIMITS,
  modelRuleAliasesField,
  modelRuleDescriptionField,
  modelRuleSubjectField,
} from '@civitai/moderation/model-rules';
import { jsonField, parseForm } from '$lib/server/query';
import { userIdByUsername } from '$lib/server/users.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { HARNESS_LIMITS } from '$lib/text-scan-lab/limits';
import {
  ENTITY_TYPE_NAMES,
  blankPromptKeys,
  describeBlankPrompts,
} from '$lib/text-scan-lab/labels';
import {
  editedPromptKeys,
  judgeCandidates,
  sourceTypeOf,
  type TryItem,
  type TryResult,
  type TrySide,
  type TrySubject,
} from '$lib/text-scan-lab/try';
import {
  DEFAULT_HEADING,
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  PROMPT_KEYS,
  isPromptKey,
  type LabEntityType,
  type LabRuleOverride,
  type LabScanResult,
  type LabText,
  type PromptChanges,
  type PromptKey,
} from '$lib/text-scan-lab/types';
import { LabError, refused } from './errors';
import { FREE_TEXT_KEY, composeEntities, scanTexts, type LabRun } from './harness-client';
import { recordChatMessageReads, type Reader } from '../chat-read-audit';

/** A draft overrides its prompt, so a blank one would scan an empty prompt: refused, never dropped.
 *  Unknown keys are refused first, so a blank one is never named as a prompt it is not. */
export function validatePromptChanges(prompts: Record<string, unknown>): PromptChanges {
  const unknownKeys = Object.keys(prompts).filter((k) => !isPromptKey(k));
  if (unknownKeys.length)
    throw new LabError(
      `Unknown prompt key ${unknownKeys.join(', ')} — allowed: ${PROMPT_KEYS.join(', ')}.`,
      400
    );
  const blank = blankPromptKeys(prompts);
  if (blank.length) throw new LabError(describeBlankPrompts(blank), 400);
  return prompts as PromptChanges;
}

export const promptChangesField = jsonField(
  z.record(z.string(), z.unknown(), { error: 'Malformed prompts.' }),
  'Malformed prompts.'
);

export const ruleOverridesField = jsonField(
  z
    .array(
      z.object({
        id: z
          .number()
          .int()
          .refine((id) => id !== 0, 'Malformed rule.'),
        subject: modelRuleSubjectField('A rule needs a subject.'),
        description: modelRuleDescriptionField,
        aliases: modelRuleAliasesField,
        enabled: z.boolean(),
      })
    )
    .max(
      MODEL_RULE_LIMITS.rulesPerTry,
      `At most ${MODEL_RULE_LIMITS.rulesPerTry} edited rules can be tried at once.`
    )
    .refine(
      (rules) => new Set(rules.map((r) => r.id)).size === rules.length,
      'Two edited rules share an id; reload the page.'
    ),
  'Malformed rules.'
);

const PROFILE_TYPES = ['UserProfile', 'User'] as const satisfies readonly LabEntityType[];

const trySchema = z.object({
  input: z
    .string()
    .max(
      HARNESS_LIMITS.charsPerText,
      `That text is too long to judge: the limit is ${HARNESS_LIMITS.charsPerText.toLocaleString(
        'en-US'
      )} characters.`
    ),
  lookupAs: z.enum(LAB_ENTITY_TYPES).catch('Model'),
  judgeAs: z.enum(LAB_ENTITY_TYPES).catch('CommentV2'),
  profileAs: z.enum(PROFILE_TYPES).catch('UserProfile'),
  prompts: promptChangesField.optional().default({}),
  rules: ruleOverridesField.optional().default([]),
});
type TryInput = z.infer<typeof trySchema>;

type Skipped = { entityId: number; error: string };
type Plan = {
  entityType: LabEntityType;
  subjects: TrySubject[];
  skipped: Skipped[];
  notice: string | null;
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
  reader: Reader,
  entityType: LabEntityType,
  ids: number[],
  title: (id: number) => string
): Promise<Plan> {
  const subjects: TrySubject[] = [];
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
  if (entityType === 'ChatMessage')
    await recordChatMessageReads(
      reader,
      subjects.flatMap((s) => (s.entityId === null ? [] : [s.entityId]))
    );
  return { entityType, subjects, skipped, notice: null };
}

const MODELS_ONLY =
  'The Model rules check judges models only: paste a model link, a model id, or some text.';

async function plan(
  reader: Reader,
  input: TryInput,
  edited: readonly PromptKey[],
  only: 'ModelRules' | null
): Promise<Plan | string> {
  const parsed = parseCheckInput(input.input);
  if (parsed.kind === 'empty') return 'Paste a Civitai link, an id, or some text.';
  if (parsed.kind === 'too-many-ids')
    return `${parsed.count} ids is more than the ${parsed.max} one check can take.`;
  if (parsed.kind === 'refused') return parsed.notice;

  const source = sourceTypeOf(parsed, input);
  if (only && !judgeCandidates(source, []).includes(only)) return MODELS_ONLY;
  const candidates = only ? [only] : judgeCandidates(source, edited);
  const judged = candidates.includes(input.judgeAs) ? input.judgeAs : candidates[0];
  const named = (id: number) => `${ENTITY_TYPE_NAMES[judged]} ${id}`;

  if (parsed.kind === 'ids' || parsed.kind === 'entity')
    return entityPlan(reader, judged, parsed.ids, named);
  if (parsed.kind === 'user') {
    const userId = await userIdByUsername(parsed.username);
    if (userId === null) return `No user called "${parsed.username}".`;
    return entityPlan(
      reader,
      judged,
      [userId],
      () => `${ENTITY_TYPE_NAMES[judged]} · ${parsed.username}`
    );
  }
  return textPlan(judged, parsed.text, parsed.kind === 'unknown-url' ? parsed.notice : null);
}

const missing = (key: string): LabScanResult => ({
  key,
  ok: false,
  error: 'No result returned for this item.',
});
const byKey = (run: LabRun) => new Map(run.results.map((r) => [r.key, r] as const));

async function scanSubjects(
  entityType: LabEntityType,
  subjects: TrySubject[],
  drafts: { prompts: PromptChanges; rules: LabRuleOverride[] }
): Promise<{ items: TryItem[]; current: TrySide; edited: TrySide | null }> {
  const texts: LabText[] = subjects.map(({ key, fields }) => ({ key, fields }));
  const rules = entityType === 'ModelRules' ? drafts.rules : [];
  const withDrafts = Object.keys(drafts.prompts).length > 0 || rules.length > 0;
  const [current, edited] = await Promise.allSettled([
    scanTexts(entityType, texts),
    withDrafts
      ? scanTexts(entityType, texts, {
          prompts: drafts.prompts as Record<string, string>,
          rules,
        })
      : Promise.resolve(null),
  ]);
  if (current.status === 'rejected') throw current.reason;
  let editedRun: LabRun | null = null;
  let refusal: string | null = null;
  if (edited.status === 'rejected') {
    if (!(edited.reason instanceof LabError)) throw edited.reason;
    refusal = edited.reason.message;
  } else editedRun = edited.value;

  const currentByKey = byKey(current.value);
  const editedByKey = editedRun && byKey(editedRun);
  return {
    items: subjects.map((s) => ({
      ...s,
      current: currentByKey.get(s.key) ?? missing(s.key),
      edited: !withDrafts
        ? null
        : refusal !== null
        ? { key: s.key, ok: false, error: refusal }
        : editedByKey?.get(s.key) ?? missing(s.key),
    })),
    current: { system: current.value.system, rules: current.value.rules },
    edited: withDrafts
      ? { system: editedRun?.system ?? null, rules: editedRun?.rules ?? null }
      : null,
  };
}

export async function runTry(
  reader: Reader,
  form: FormData,
  opts: { only?: 'ModelRules' | null } = {}
): Promise<TryResult | ActionFailure<{ error: string }>> {
  const input = parseForm(trySchema, form);
  if (typeof input === 'string') return fail(400, { error: input });

  let prompts: PromptChanges;
  try {
    prompts = validatePromptChanges(input.prompts);
  } catch (e) {
    return refused(e);
  }

  let planned: Plan | string;
  try {
    planned = await plan(reader, input, editedPromptKeys(prompts, input.rules), opts.only ?? null);
  } catch (e) {
    return refused(e);
  }
  if (typeof planned === 'string') return fail(400, { error: planned });
  const { entityType, subjects, skipped, notice } = planned;
  if (!subjects.length)
    return fail(400, {
      error: `Nothing to check: ${skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.`,
    });

  try {
    const scanned = await scanSubjects(entityType, subjects, { prompts, rules: input.rules });
    return {
      tried: true,
      entityType,
      labels: LAB_LABELS[entityType],
      notice,
      skipped,
      ...scanned,
    } satisfies TryResult;
  } catch (e) {
    return refused(e);
  }
}
