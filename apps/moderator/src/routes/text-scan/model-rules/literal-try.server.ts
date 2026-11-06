import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import {
  MODEL_RULE_LIMITS,
  modelRuleAliasesField,
  modelRuleDescriptionField,
  modelRuleSubjectField,
  type ModelRulesHoldMatch,
} from '@civitai/moderation/model-rules';
import { jsonField, parseForm } from '$lib/server/query';
import { refused } from '$lib/server/text-scan-lab/errors';
import { FREE_TEXT_KEY, composeEntities } from '$lib/server/text-scan-lab/harness-client';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { HARNESS_LIMITS } from '$lib/text-scan-lab/limits';
import type { LabField } from '$lib/text-scan-lab/types';
import type { LiteralTryItem, LiteralTryResult, LiteralTryRule } from './literal-try';

const ruleOverridesField = jsonField(
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

const trySchema = z.object({
  input: z
    .string()
    .max(
      HARNESS_LIMITS.charsPerText,
      `That text is too long to try: the limit is ${HARNESS_LIMITS.charsPerText.toLocaleString(
        'en-US'
      )} characters.`
    ),
  rules: ruleOverridesField.optional().default([]),
});

type Subject = { key: string; title: string; fields: LabField[] };
type Plan = { subjects: Subject[]; skipped: LiteralTryResult['skipped']; notice: string | null };

const MODELS_ONLY = 'Model rules apply to models: paste a model link, a model id, or some text.';

async function plan(raw: string): Promise<Plan | string> {
  const parsed = parseCheckInput(raw);
  switch (parsed.kind) {
    case 'empty':
      return 'Paste a model link, a model id, or some text.';
    case 'too-many-ids':
      return `${parsed.count} ids is more than the ${parsed.max} one try can take.`;
    case 'refused':
      return parsed.notice;
    case 'user':
      return MODELS_ONLY;
    case 'entity':
      if (parsed.entityType !== 'Model') return MODELS_ONLY;
    // falls through
    case 'ids': {
      const subjects: Subject[] = [];
      const skipped: LiteralTryResult['skipped'] = [];
      for (const entity of await composeEntities('Model', parsed.ids)) {
        if (entity.ok)
          subjects.push({
            key: String(entity.entityId),
            title: `Model ${entity.entityId}`,
            fields: entity.fields,
          });
        else skipped.push({ entityId: entity.entityId, error: entity.error });
      }
      if (!subjects.length)
        return `Nothing to try: ${skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.`;
      return { subjects, skipped, notice: null };
    }
    case 'text':
    case 'unknown-url': {
      const fields = normaliseLabFields([{ heading: 'Name', text: parsed.text }]);
      if (typeof fields === 'string') return fields;
      if (!fields.length) return 'Paste a model link, a model id, or some text.';
      return {
        subjects: [{ key: FREE_TEXT_KEY, title: 'Your text', fields }],
        skipped: [],
        notice: parsed.kind === 'unknown-url' ? parsed.notice : null,
      };
    }
  }
}

const answerSchema = z.object({
  rules: z.array(z.object({ id: z.number(), subject: z.string() })),
  results: z.array(
    z.object({
      key: z.string(),
      matches: z.array(
        z.object({
          ruleId: z.number(),
          term: z.string(),
          field: z.string(),
          fieldIndex: z.number(),
          start: z.number(),
          end: z.number(),
        })
      ),
    })
  ),
}) satisfies z.ZodType<{
  rules: LiteralTryRule[];
  results: { key: string; matches: ModelRulesHoldMatch[] }[];
}>;

/**
 * Which rules, and which of their terms, match the text, with where. The main app's matcher does
 * the matching, so a try says what a publish would. `rules` edits are tried as unsaved rules.
 */
export async function runLiteralTry(
  form: FormData
): Promise<LiteralTryResult | ActionFailure<{ error: string }>> {
  const input = parseForm(trySchema, form);
  if (typeof input === 'string') return fail(400, { error: input });

  let planned: Plan | string;
  try {
    planned = await plan(input.input);
  } catch (e) {
    return refused(e);
  }
  if (typeof planned === 'string') return fail(400, { error: planned });

  const result = await callModEndpoint(
    'text-scan',
    {
      action: 'literalModelRules',
      texts: planned.subjects.map(({ key, fields }) => ({ key, fields })),
      ...(input.rules.length ? { ruleOverrides: input.rules } : {}),
    },
    'Try model rules'
  );
  if (!result.ok) return fail(502, { error: result.error });

  const answer = answerSchema.safeParse(result.body);
  if (!answer.success)
    return fail(502, { error: 'The main app gave an unreadable answer; nothing was tried.' });
  const byKey = new Map(answer.data.results.map((r) => [r.key, r.matches]));
  // A subject the answer left out was never judged, so it must not read as "no rule matched".
  const unjudged = planned.subjects.filter((subject) => !byKey.has(subject.key));
  if (unjudged.length)
    return fail(502, {
      error: `The main app's answer left out ${unjudged
        .map((subject) => subject.title)
        .join(', ')}; nothing was tried.`,
    });
  const items: LiteralTryItem[] = planned.subjects.map((subject) => ({
    ...subject,
    matches: byKey.get(subject.key) ?? [],
  }));
  return {
    tried: true,
    notice: planned.notice,
    rules: answer.data.rules,
    items,
    skipped: planned.skipped,
  };
}
