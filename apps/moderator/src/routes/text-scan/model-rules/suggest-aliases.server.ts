import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import { modelRuleDescriptionField, modelRuleSubjectField } from '@civitai/moderation/model-rules';
import { MODEL_RULE_LIMITS, parseAliases } from '$lib/model-rules';
import { parseForm } from '$lib/server/query';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { ALIAS_KINDS, type SuggestAliasesResult } from './suggest-aliases';

// The main app waits up to 90s for the web search; this must outlast it, or a slow answer reads as
// a failure although the call was billed.
const SUGGEST_TIMEOUT_MS = 110_000;

const formSchema = z.object({
  subject: modelRuleSubjectField('Enter the rule’s subject first.'),
  description: modelRuleDescriptionField.default(''),
  aliases: z
    .string()
    .default('')
    .transform(parseAliases)
    .pipe(z.array(z.string()).max(MODEL_RULE_LIMITS.aliasesPerRule)),
});

const answerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    suggestions: z.array(
      z.object({
        alias: z.string().min(1),
        kind: z.enum(ALIAS_KINDS),
        note: z.string().optional(),
        // Web text decides this link: only http(s) ever reaches an href.
        source: z
          .string()
          .regex(/^https?:\/\//)
          .optional()
          .catch(undefined),
      })
    ),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** One billed web-search call per run, never retried: the moderator decides whether to click again. */
export async function runSuggestAliases(
  form: FormData
): Promise<SuggestAliasesResult | ActionFailure<{ error: string }>> {
  const input = parseForm(formSchema, form);
  if (typeof input === 'string') return fail(400, { error: input });

  const result = await callModEndpoint(
    'text-scan',
    {
      action: 'suggestModelRuleAliases',
      subject: input.subject,
      description: input.description,
      existingAliases: input.aliases,
    },
    'Suggest model rule aliases',
    SUGGEST_TIMEOUT_MS
  );
  if (!result.ok) return fail(502, { error: result.error });

  const answer = answerSchema.safeParse(result.body);
  if (!answer.success)
    return fail(502, {
      error: 'The main app gave an unreadable answer; no aliases were suggested.',
    });
  if (!answer.data.ok) return fail(502, { error: answer.data.error });
  return { suggested: true, suggestions: answer.data.suggestions };
}
