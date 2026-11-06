import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import {
  aliasKindField,
  aliasWorkflowIdField,
  modelRuleDescriptionField,
  modelRuleSubjectField,
} from '@civitai/moderation/model-rules';
import { MODEL_RULE_LIMITS, parseAliases } from '$lib/model-rules';
import { parseForm } from '$lib/server/query';
import { callModEndpoint } from '$lib/server/user-actions.service';
import type { AliasResultAnswer, SuggestAliasesResult } from './suggest-aliases';

// The main app answers within seconds (it submits and waits briefly), so this is a transport guard,
// not a budget for the search itself.
const REQUEST_TIMEOUT_MS = 30_000;

const ruleFields = {
  subject: modelRuleSubjectField('Enter the rule’s subject first.'),
  aliases: z
    .string()
    .default('')
    .transform(parseAliases)
    .pipe(z.array(z.string()).max(MODEL_RULE_LIMITS.aliasesPerRule)),
};
const submitSchema = z.object({
  ...ruleFields,
  description: modelRuleDescriptionField.default(''),
});
const resultSchema = z.object({ ...ruleFields, workflowId: aliasWorkflowIdField });

const suggestionsSchema = z.array(
  z.object({
    alias: z.string().min(1),
    kind: aliasKindField,
    note: z.string().optional(),
    // Web text decides this link: only http(s) ever reaches an href.
    source: z
      .string()
      .regex(/^https?:\/\//)
      .optional()
      .catch(undefined),
  })
);
const costField = z.number().finite().nonnegative().optional().catch(undefined);
const done = z.object({
  ok: z.literal(true),
  status: z.literal('done'),
  suggestions: suggestionsSchema,
  costTotal: costField,
});
const refused = z.object({ ok: z.literal(false), error: z.string() });
/** The search can never be read back (gone, or not an alias search): polling it again is pointless. */
const gone = z.object({
  ok: z.literal(false),
  reason: z.enum(['not_found', 'not_alias_workflow']),
  error: z.string(),
});

const submitAnswer = z.union([
  done,
  z.object({ ok: z.literal(true), status: z.literal('pending'), workflowId: aliasWorkflowIdField }),
  refused,
]);
const resultAnswer = z.union([
  done,
  z.object({ ok: z.literal(true), status: z.literal('pending') }),
  z.object({ ok: z.literal(true), status: z.literal('failed'), error: z.string() }),
  gone,
  refused,
]);

const UNREADABLE = 'The main app gave an unreadable answer; no aliases were suggested.';

const finished = ({ suggestions, costTotal }: z.infer<typeof done>) =>
  ({
    suggested: true,
    status: 'done',
    suggestions,
    ...(costTotal === undefined ? {} : { costTotal }),
  } as const);

/** One billed web-search call per run, never retried: the moderator decides whether to click again. */
export async function runSuggestAliases(
  form: FormData
): Promise<SuggestAliasesResult | ActionFailure<{ error: string }>> {
  const input = parseForm(submitSchema, form);
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
    REQUEST_TIMEOUT_MS
  );
  if (!result.ok) return fail(502, { error: result.error });

  const answer = submitAnswer.safeParse(result.body);
  if (!answer.success) return fail(502, { error: UNREADABLE });
  if (!answer.data.ok) return fail(502, { error: answer.data.error });
  if (answer.data.status === 'pending')
    return { suggested: true, status: 'pending', workflowId: answer.data.workflowId };
  return finished(answer.data);
}

/** Reads back a search `runSuggestAliases` started; free to repeat. */
export async function runAliasSuggestionResult(
  form: FormData
): Promise<AliasResultAnswer | ActionFailure<{ error: string }>> {
  const input = parseForm(resultSchema, form);
  if (typeof input === 'string') return fail(400, { error: input });

  const result = await callModEndpoint(
    'text-scan',
    {
      action: 'aliasSuggestionResult',
      workflowId: input.workflowId,
      subject: input.subject,
      existingAliases: input.aliases,
    },
    'Read model rule alias suggestions',
    REQUEST_TIMEOUT_MS
  );
  // The main app rejecting the request itself is a permanent refusal; anything else is transport.
  if (!result.ok) return fail(result.status === 400 ? 400 : 502, { error: result.error });

  const answer = resultAnswer.safeParse(result.body);
  if (!answer.success) return fail(502, { error: UNREADABLE });
  if (!answer.data.ok)
    return 'reason' in answer.data
      ? { suggested: true, status: 'failed', error: answer.data.error }
      : fail(502, { error: answer.data.error });
  if (answer.data.status === 'pending') return { suggested: true, status: 'pending' };
  if (answer.data.status === 'failed')
    return { suggested: true, status: 'failed', error: answer.data.error };
  return finished(answer.data);
}
