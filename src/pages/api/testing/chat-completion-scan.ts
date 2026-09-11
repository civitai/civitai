/**
 * chatCompletion text-scan spike endpoint — CU 868m4de9j.
 * =============================================================================
 *
 * Hidden testing route guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Submits a RAW `chatCompletion` workflow step — not `xGuardModeration` — so we
 * can measure whether a general instruct model can replace the purpose-built
 * guard model behind text moderation. Writes no `EntityModeration` row and no
 * audit entry.
 *
 * Every unknown this spike has to settle is a separate toggle, so they can be
 * probed one at a time instead of as one pass/fail:
 *
 *   responseFormat        'none' | 'json_object' | 'json_schema'
 *   chatTemplateKwargs    arbitrary object (reported to 500 on an older build)
 *   logprobs/topLogprobs  whether a usable distribution comes back
 *   model                 the fallback ladder
 *
 * Usage:
 *   POST /api/testing/chat-completion-scan?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *
 * Actions:
 *
 *   { "action": "whatif", ... }
 *     Price the request without running it. Answers "is text-only AIR still
 *     0 Buzz", and prices an OpenRouter fallback for comparison.
 *
 *   { "action": "scan", "text": "...", "labels": ["nsfw"], ... }
 *     One synchronous scan. Returns the raw assistant content, the
 *     server-parsed `output.parsed` when a JSON responseFormat was requested,
 *     logprobs, token usage, and an outcome classification.
 *
 *   { "action": "fetch", "workflowId": "..." }
 *     Re-read a finished workflow through `getWorkflow`. This is how we verify
 *     `parsed` survives onto the persisted workflow — which is what the real
 *     callback handler reads. A local dev server cannot receive an orchestrator
 *     callback, so this stands in for it.
 *
 *   { "action": "batch", "texts": ["...", "..."], ... }
 *     Up to 50 texts, concurrency-limited. Returns per-item outcomes plus a
 *     refusal-rate and score-distribution summary — the two measurements that
 *     decide whether a general model can do this job at all.
 *
 * Label POLICY text is an input, never a default in this file: policy text and
 * thresholds must not be committed (CLAUDE.md Security §2). `labels` here are
 * bare names; pass definitions via `labelDefinitions` or `systemPrompt` at call
 * time. Export the live ones with
 * `.claude/skills/xguard-manager/manage.mjs get text`.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ChatCompletionStepTemplate } from '@civitai/client';
import { getWorkflow, submitWorkflow } from '@civitai/client';
import pLimit from 'p-limit';
import * as z from 'zod';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const DEFAULT_MODEL =
  'urn:air:qwen3:repository:huggingface:gittensor-model-hub/Qwen3.8-27B-NVFP4-RTX5090@main.tar';

/**
 * Structural only — it states the output shape and says nothing about what any
 * label means. Keeping policy out of it is what makes this file committable.
 */
const DEFAULT_SYSTEM_PROMPT = `You are a content classification service. You will be given a block of user-submitted text and a list of labels.

For each label, return a score between 0 and 1 for how strongly the text matches that label, and a one-sentence reason.

Respond with ONLY a JSON object of the form:
{"labels":[{"name":"<label>","score":<0-1>,"reason":"<one sentence>"}]}

Include every label you were given, even when the score is 0. Do not add labels you were not given. Do not refuse: scoring text is not the same as producing it.`;

const labelResultSchema = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['name', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
} as const;

const commonFields = {
  model: z.string().min(1).default(DEFAULT_MODEL),
  labels: z.array(z.string().min(1)).min(1),
  /** Optional per-label definitions, appended to the system prompt. */
  labelDefinitions: z.record(z.string(), z.string()).optional(),
  systemPrompt: z.string().min(1).optional(),
  responseFormat: z.enum(['none', 'json_object', 'json_schema']).default('json_schema'),
  logprobs: z.boolean().default(false),
  topLogprobs: z.number().int().min(1).max(20).optional(),
  maxTokens: z.number().int().min(1).max(8192).default(1024),
  temperature: z.number().min(0).max(2).default(0),
  chatTemplateKwargs: z.record(z.string(), z.unknown()).optional(),
  wait: z.number().int().min(1).max(120).default(60),
};

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('scan'), text: z.string().min(1), ...commonFields }),
  z.object({ action: z.literal('whatif'), text: z.string().min(1), ...commonFields }),
  z.object({ action: z.literal('fetch'), workflowId: z.string().min(1) }),
  z.object({
    action: z.literal('batch'),
    texts: z.array(z.string().min(1)).min(1).max(50),
    concurrency: z.number().int().min(1).max(8).default(3),
    ...commonFields,
  }),
]);

type ScanInput = Extract<z.infer<typeof schema>, { action: 'scan' }>;

/**
 * A refusal, a truncation and a malformed reply all look like "no labels
 * triggered" to a naive parser, and conflating them is the failure mode this
 * whole spike exists to rule out — so they are separate outcomes, and the raw
 * content is returned for every non-`ok` so a human can check the call rather
 * than trusting this function.
 */
type Outcome = 'ok' | 'refused' | 'malformed' | 'empty' | 'truncated' | 'missing_labels';

const REFUSAL_CUES = [
  "i can't",
  'i cannot',
  "i won't",
  'i will not',
  'i am unable',
  "i'm unable",
  'i apologize',
  "i'm sorry",
  'i am sorry',
  'as an ai',
  'cannot assist',
  "can't assist",
  'cannot help with',
  'against my',
  'not able to provide',
];

function classify({
  content,
  parsed,
  finishReason,
  requestedLabels,
}: {
  content: string | null | undefined;
  parsed: unknown;
  finishReason: string | null | undefined;
  requestedLabels: string[];
}): { outcome: Outcome; scores: Record<string, number> | null } {
  if (!content || !content.trim()) return { outcome: 'empty', scores: null };

  const json = parsed ?? tryParse(content);
  if (json === undefined) {
    const lower = content.toLowerCase();
    const refused = REFUSAL_CUES.some((cue) => lower.includes(cue));
    if (refused) return { outcome: 'refused', scores: null };
    // A truncated reply is only diagnosable as such via finishReason — the text
    // itself is indistinguishable from a model that just wrote prose.
    if (finishReason === 'length') return { outcome: 'truncated', scores: null };
    return { outcome: 'malformed', scores: null };
  }

  const labels = (json as { labels?: Array<{ name?: string; score?: number }> })?.labels;
  if (!Array.isArray(labels)) return { outcome: 'malformed', scores: null };

  const scores: Record<string, number> = {};
  for (const entry of labels) {
    if (typeof entry?.name === 'string' && typeof entry.score === 'number') {
      scores[entry.name.toLowerCase()] = entry.score;
    }
  }

  const missing = requestedLabels.filter((l) => !(l.toLowerCase() in scores));
  if (missing.length) return { outcome: 'missing_labels', scores };

  return { outcome: 'ok', scores };
}

function tryParse(content: string): unknown | undefined {
  const candidates = [content];
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1]);
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(content.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // next candidate
    }
  }
  return undefined;
}

function buildStep(input: Omit<ScanInput, 'action'> & { text: string }): ChatCompletionStepTemplate {
  const definitions = input.labelDefinitions
    ? `\n\nLabel definitions:\n${input.labels
        .map((l) => `- ${l}: ${input.labelDefinitions?.[l] ?? '(no definition supplied)'}`)
        .join('\n')}`
    : '';

  const system = `${input.systemPrompt ?? DEFAULT_SYSTEM_PROMPT}

Labels to score: ${input.labels.join(', ')}${definitions}`;

  const chatInput: Record<string, unknown> = {
    model: input.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input.text },
    ],
    temperature: input.temperature,
    maxTokens: input.maxTokens,
  };

  if (input.responseFormat === 'json_object') {
    chatInput.responseFormat = { type: 'json_object' };
  } else if (input.responseFormat === 'json_schema') {
    chatInput.responseFormat = {
      type: 'json_schema',
      jsonSchema: { name: 'label_scores', schema: labelResultSchema, strict: true },
    };
  }
  if (input.logprobs) {
    chatInput.logprobs = true;
    if (input.topLogprobs !== undefined) chatInput.topLogprobs = input.topLogprobs;
  }
  if (input.chatTemplateKwargs) chatInput.chatTemplateKwargs = input.chatTemplateKwargs;

  return {
    $type: 'chatCompletion',
    name: 'textScanSpike',
    input: chatInput,
  } as ChatCompletionStepTemplate;
}

type StepShape = {
  $type?: string;
  output?: {
    choices?: Array<{
      message?: { content?: string | null };
      finishReason?: string | null;
      finish_reason?: string | null;
      logprobs?: unknown;
    }>;
    usage?: unknown;
    parsed?: unknown;
  };
};

function readStep(workflow: unknown) {
  const steps = (workflow as { steps?: StepShape[] })?.steps ?? [];
  const step = steps.find((s) => s.$type === 'chatCompletion') ?? steps[0];
  const choice = step?.output?.choices?.[0];
  return {
    content: choice?.message?.content,
    finishReason: choice?.finishReason ?? choice?.finish_reason,
    logprobs: choice?.logprobs ?? null,
    usage: step?.output?.usage ?? null,
    parsed: step?.output?.parsed ?? null,
    hasOutput: !!step?.output,
  };
}

async function runOne(input: Omit<ScanInput, 'action'> & { text: string }) {
  const startedAt = Date.now();
  const { data, error, response } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: input.wait },
    body: { currencies: [], steps: [buildStep(input)] },
  });

  if (!data?.id) {
    return {
      ok: false as const,
      error: 'orchestrator returned no workflow id',
      httpStatus: response?.status,
      orchestratorError: error ?? null,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const step = readStep(data);
  const { outcome, scores } = classify({
    content: step.content,
    parsed: step.parsed,
    finishReason: step.finishReason,
    requestedLabels: input.labels,
  });

  return {
    ok: true as const,
    workflowId: data.id,
    status: (data as { status?: string }).status,
    outcome,
    scores,
    parsedPresent: step.parsed != null,
    logprobsPresent: step.logprobs != null,
    finishReason: step.finishReason ?? null,
    usage: step.usage,
    // Returned for every non-`ok` so the outcome classification above can be
    // checked rather than believed.
    rawContent: outcome === 'ok' ? undefined : step.content,
    elapsedMs: Date.now() - startedAt,
  };
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const input = parsed.data;

  try {
    if (input.action === 'fetch') {
      const { data } = await getWorkflow({
        client: internalOrchestratorClient,
        path: { workflowId: input.workflowId },
      });
      const step = readStep(data);
      return res.status(200).json({
        workflowId: input.workflowId,
        status: (data as { status?: string } | undefined)?.status,
        hasOutput: step.hasOutput,
        parsedPresent: step.parsed != null,
        parsed: step.parsed,
        logprobsPresent: step.logprobs != null,
        finishReason: step.finishReason ?? null,
        usage: step.usage,
        content: step.content,
      });
    }

    if (input.action === 'whatif') {
      const { data, error, response } = await submitWorkflow({
        client: internalOrchestratorClient,
        query: { whatif: true },
        body: { currencies: [], steps: [buildStep(input)] },
      });
      return res.status(200).json({
        model: input.model,
        httpStatus: response?.status,
        quote: data ?? null,
        orchestratorError: error ?? null,
      });
    }

    if (input.action === 'scan') return res.status(200).json(await runOne(input));

    const limit = pLimit(input.concurrency);
    const results = await Promise.all(
      input.texts.map((text, index) =>
        limit(async () => ({ index, chars: text.length, ...(await runOne({ ...input, text })) }))
      )
    );

    const byOutcome: Record<string, number> = {};
    const allScores: number[] = [];
    for (const r of results) {
      const key = r.ok ? r.outcome : 'submit_failed';
      byOutcome[key] = (byOutcome[key] ?? 0) + 1;
      if (r.ok && r.scores) allScores.push(...Object.values(r.scores));
    }
    allScores.sort((a, b) => a - b);
    const at = (q: number) => allScores[Math.floor((allScores.length - 1) * q)] ?? null;

    return res.status(200).json({
      model: input.model,
      count: results.length,
      byOutcome,
      refusalRate: results.length ? (byOutcome.refused ?? 0) / results.length : 0,
      // Clustering here is the real finding, not the centre: scores bunched on
      // a few round values cannot support a threshold, however accurate they are.
      scoreDistribution: allScores.length
        ? {
            n: allScores.length,
            distinctValues: new Set(allScores).size,
            min: allScores[0],
            p25: at(0.25),
            median: at(0.5),
            p75: at(0.75),
            max: allScores[allScores.length - 1],
          }
        : null,
      results,
    });
  } catch (e) {
    const error = e as Error;
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
});
