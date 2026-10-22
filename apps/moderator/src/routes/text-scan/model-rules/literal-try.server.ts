import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import type { ModelRulesHoldMatch } from '@civitai/moderation/model-rules';
import { parseForm } from '$lib/server/query';
import { refused } from '$lib/server/text-scan-lab/errors';
import { FREE_TEXT_KEY, composeEntities } from '$lib/server/text-scan-lab/harness-client';
import { ruleOverridesField } from '$lib/server/text-scan-lab/try';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { HARNESS_LIMITS } from '$lib/text-scan-lab/limits';
import type { LabField } from '$lib/text-scan-lab/types';
import type { LiteralTryItem, LiteralTryResult, LiteralTryRule } from './literal-try';

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

type Answer = {
  rules: LiteralTryRule[];
  results: { key: string; matches: ModelRulesHoldMatch[] }[];
};

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

  const answer = result.body as unknown as Answer;
  const byKey = new Map(answer.results.map((r) => [r.key, r.matches]));
  const items: LiteralTryItem[] = planned.subjects.map((subject) => ({
    ...subject,
    matches: byKey.get(subject.key) ?? [],
  }));
  return {
    tried: true,
    notice: planned.notice,
    rules: answer.rules,
    items,
    skipped: planned.skipped,
  };
}
