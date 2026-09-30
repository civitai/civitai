import {
  AI_MODELS,
  extractUsage,
  openrouter,
  type TokenUsage,
} from '~/server/services/ai/openrouter';
import { extractJson } from '~/server/services/ai/json-extract';

/**
 * Jev vendor seam — bounded judgments only: Choice (full distribution), Score
 * (ordered rubric), Noul (P(yes)). The model cannot generate prose, count, or
 * compare dates, so callers ask ONLY these three shapes; everything structural
 * (base models, ids, ordering) stays in deterministic code.
 *
 * Fail-closed contract: every parse below THROWS on any violation (unknown
 * answer keys, an option outside the question's option set, a distribution that
 * does not sum to ~1, a score outside its rubric, timeout). Callers catch and
 * degrade — they never receive a partially-valid answer.
 *
 * Model pin: `AI_MODELS.JEV` (numbered) — `provider.allowFallbacks` is FALSE so
 * OpenRouter cannot silently route the call to a different model and make the
 * recorded `model` a lie. The numbering is not stylistic: measured 2026-09-30,
 * `typesafe/jev-1.13` resolves (one endpoint, 32k ctx) while `typesafe/jev-latest`
 * returns 404, so an unnumbered slug does not exist to fall back to.
 */

export type JevChoiceQuestion = {
  id: string;
  type: 'choice';
  prompt: string;
  options: readonly string[];
};
export type JevScoreQuestion = {
  id: string;
  type: 'score';
  prompt: string;
  min: number;
  max: number;
};
export type JevNoulQuestion = { id: string; type: 'noul'; prompt: string };
export type JevQuestionSpec = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion;

export type JevRequest = {
  /** Judgment state — ONLY the inputs the questions need (the prompt, short context). */
  state: Record<string, string>;
  questions: readonly JevQuestionSpec[];
};

export type JevAnswer =
  | {
      id: string;
      type: 'choice';
      value: string;
      distribution: Record<string, number>;
      confidence?: number;
    }
  | { id: string; type: 'score'; value: number; confidence?: number }
  | { id: string; type: 'noul'; value: number; confidence?: number };

export type JevResponse = {
  answers: JevAnswer[];
  usage: TokenUsage;
  model: string;
};

export class JevError extends Error {
  readonly kind: 'not-configured' | 'timeout' | 'malformed' | 'transport';
  constructor(kind: JevError['kind'], message: string) {
    super(message);
    this.kind = kind;
    this.name = 'JevError';
  }
}

// The whole response must land within this window; Jev's vendor p50 is 70–500ms
// and the resource-intent p95 target is 2s end-to-end including the matcher.
export const JEV_TIMEOUT_MS = 2000;
// Distributions are full-probability; a float-rounding drift up to this much is
// tolerated, anything else is malformed.
export const JEV_DISTRIBUTION_SUM_TOLERANCE = 0.02;
export const JEV_MAX_CHOICE_OPTIONS = 255;

const ANSWER_KEYS = new Set(['value', 'distribution', 'confidence']);

function fail(kind: JevError['kind'], message: string): never {
  throw new JevError(kind, message);
}

function parseAnswer(question: JevQuestionSpec, raw: unknown, idPath: string): JevAnswer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('malformed', `answer for "${idPath}" is not an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ANSWER_KEYS.has(key)) {
      fail('malformed', `unknown answer key "${key}" for question "${idPath}"`);
    }
  }
  let confidence: number | undefined;
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) {
      fail('malformed', `confidence for "${idPath}" is not a finite number`);
    }
    confidence = record.confidence;
  }

  switch (question.type) {
    case 'choice': {
      const options = new Set<string>(question.options);
      if (typeof record.value !== 'string' || !options.has(record.value)) {
        fail('malformed', `answer value for "${idPath}" is not one of the offered options`);
      }
      const distribution = record.distribution;
      if (
        distribution === null ||
        typeof distribution !== 'object' ||
        Array.isArray(distribution)
      ) {
        fail('malformed', `distribution for "${idPath}" is missing or not an object`);
      }
      const entries = Object.entries(distribution as Record<string, unknown>);
      if (entries.length === 0) {
        fail('malformed', `distribution for "${idPath}" is empty`);
      }
      let sum = 0;
      const parsed: Record<string, number> = {};
      for (const [option, probability] of entries) {
        if (!options.has(option)) {
          fail('malformed', `distribution for "${idPath}" names unknown option "${option}"`);
        }
        if (
          typeof probability !== 'number' ||
          !Number.isFinite(probability) ||
          probability < 0 ||
          probability > 1
        ) {
          fail('malformed', `distribution probability for "${idPath}"/"${option}" is not in [0,1]`);
        }
        parsed[option] = probability;
        sum += probability;
      }
      if (Math.abs(sum - 1) > JEV_DISTRIBUTION_SUM_TOLERANCE) {
        fail('malformed', `distribution for "${idPath}" sums to ${sum}, expected ~1`);
      }
      return {
        id: question.id,
        type: 'choice',
        value: record.value,
        distribution: parsed,
        confidence,
      };
    }
    case 'score': {
      const { value } = record;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < question.min ||
        value > question.max
      ) {
        fail(
          'malformed',
          `score for "${idPath}" is not an integer in [${question.min},${question.max}]`
        );
      }
      return { id: question.id, type: 'score', value, confidence };
    }
    case 'noul': {
      const { value } = record;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        fail('malformed', `noul for "${idPath}" is not a probability in [0,1]`);
      }
      return { id: question.id, type: 'noul', value, confidence };
    }
  }
}

export function buildPrompt(request: JevRequest): { system: string; user: string } {
  // 🔴 The `answers` envelope is REQUIRED here because `askJev` rejects any other
  // top-level key. An earlier draft described the per-answer shape and never named
  // the wrapper, so a model that followed the prompt exactly returned answers at the
  // top level and was refused as malformed on EVERY call — the endpoint would have
  // been 100% degraded from its first real request, silently, since a degraded
  // response is indistinguishable from an honest "no resource needed". Keep the
  // wrapper named here and in the example below; `jev.test.ts` pins the round trip.
  const system = [
    'You are a bounded judgment engine. You never write prose.',
    'You receive a state and a list of questions.',
    'Return a JSON object with EXACTLY ONE top-level key, "answers", whose value is an object keyed by question id.',
    'Include EVERY question id exactly once. Do not add any other top-level key.',
    'Answer shape by question type:',
    '- choice: {"value": "<one of options>", "distribution": {"<option>": <probability 0..1>}} — the distribution must cover the offered options and sum to 1.',
    '- score: {"value": <integer within the stated range>}',
    '- noul: {"value": <probability 0..1>}',
    'You may add "confidence": <0..1> to any answer.',
    'Example for questions with ids "a" (noul) and "b" (choice over x|y):',
    '{"answers":{"a":{"value":0.8},"b":{"value":"x","distribution":{"x":0.7,"y":0.3}}}}',
    'Respond with ONLY that JSON object.',
  ].join('\n');
  const user = `State:\n${JSON.stringify(request.state)}\n\nQuestions:\n${JSON.stringify(
    request.questions.map(({ id, type, prompt, ...rest }) => ({ id, type, prompt, ...rest }))
  )}`;
  return { system, user };
}

export async function askJev(
  request: JevRequest,
  opts: { timeoutMs?: number } = {}
): Promise<JevResponse> {
  if (request.questions.length === 0) {
    fail('malformed', 'a Jev request must carry at least one question');
  }
  const ids = new Set<string>();
  for (const question of request.questions) {
    if (ids.has(question.id)) fail('malformed', `duplicate question id "${question.id}"`);
    ids.add(question.id);
    if (question.type === 'choice') {
      if (question.options.length < 2)
        fail('malformed', `choice "${question.id}" needs >=2 options`);
      if (question.options.length > JEV_MAX_CHOICE_OPTIONS) {
        fail('malformed', `choice "${question.id}" exceeds ${JEV_MAX_CHOICE_OPTIONS} options`);
      }
    }
  }

  const client = openrouter;
  if (!client) {
    fail('not-configured', 'OPENROUTER_API_KEY is not configured');
  }

  const model = AI_MODELS.JEV;
  const { system, user } = buildPrompt(request);
  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  // The timer ABORTS the request itself (the SDK threads the signal to fetch),
  // so a timed-out call does not hold its connection open; the Promise.race is
  // the belt for an SDK that ever ignores the signal.
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(new JevError('timeout', `Jev call exceeded ${timeoutMs}ms`)),
    timeoutMs
  );

  let content: unknown;
  let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
  try {
    const response = await Promise.race([
      client.chat.send(
        {
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          maxTokens: 4096,
          responseFormat: { type: 'json_object' },
          provider: { allowFallbacks: false },
        },
        { signal: abortController.signal }
      ),
      new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () =>
          reject(
            abortController.signal.reason instanceof JevError
              ? abortController.signal.reason
              : new JevError('timeout', `Jev call exceeded ${timeoutMs}ms`)
          )
        );
      }),
    ]);
    usage = extractUsage(response);
    const raw = response.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') {
      fail('malformed', 'no content in Jev response');
    }
    content = extractJson(raw);
  } catch (error) {
    if (error instanceof JevError) throw error;
    if (abortController.signal.aborted) {
      throw new JevError('timeout', `Jev call exceeded ${timeoutMs}ms`);
    }
    fail('transport', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    fail('malformed', 'Jev response is not a JSON object');
  }
  const envelope = content as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (key !== 'answers') {
      fail('malformed', `unknown top-level key "${key}" in Jev response`);
    }
  }
  const answersRaw = envelope.answers;
  if (answersRaw === null || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) {
    fail('malformed', 'Jev response is missing an answers object');
  }
  const answersById = answersRaw as Record<string, unknown>;
  for (const key of Object.keys(answersById)) {
    if (!ids.has(key)) {
      fail('malformed', `unknown answer key "${key}" in Jev response`);
    }
  }
  const answers = request.questions.map((question) =>
    parseAnswer(question, answersById[question.id], question.id)
  );

  return { answers, usage, model };
}

/*
 * There is deliberately NO direct-`api.typesafe.ai` seam here. An earlier draft
 * shipped one as a function that only ever threw, plus a `TYPESAFE_API_KEY` env
 * entry nothing read. It bought nothing: `askJev` is already the interface a
 * transport swap would replace, and the direct path additionally needs a SOPS
 * secret and an egress decision that no stub can pre-make. Add it when it is
 * wired, not before.
 */
