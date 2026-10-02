import { env } from '~/env/server';
import { AI_MODELS, type TokenUsage } from '~/server/services/ai/openrouter';

/**
 * Jev vendor seam — bounded judgments only: Choice (full distribution), Score
 * (ordered rubric), Noul (P(yes)). The model cannot generate prose, count, or
 * compare dates, so callers ask ONLY these three shapes; everything structural
 * (base models, ids, ordering) stays in deterministic code.
 *
 * 🔴 TRANSPORT: `POST /api/alpha/decisions`, NOT chat/completions.
 * `typesafe/jev-1.13` is a *decisions* model. Posting it to
 * `/api/v1/chat/completions` returns HTTP 400 in ~200ms with
 * `"typesafe/jev-1.13 is a decisions model and cannot be used with the
 * chat/completions endpoint. Use the /api/alpha/decisions endpoint instead."`
 * — measured 2026-10-01 against the live vendor, with both controls run: the
 * SAME key/endpoint/parameters with `openai/gpt-4o-mini` returns 200, and
 * `/api/v1/models/typesafe/jev-1.13/endpoints` confirms the model is real
 * (provider TypeSafe, `supported_parameters: []` — it declares no chat
 * parameters because it is not a chat model). The first implementation of this
 * file flattened its `{ state, questions }` contract into chat messages via a
 * `buildPrompt` helper and so returned 400 on EVERY call in production, for its
 * whole life, while a comprehensive mocked test suite stayed green. A green
 * suite over a mocked vendor is a claim about the mock.
 *
 * 🔴 The wire contract below was recovered from the endpoint's own Zod
 * validation errors — OpenRouter publishes no docs page for it
 * (`/docs/api-reference/decisions` → 404) — and confirmed by a recorded 200.
 * It is an ALPHA endpoint: re-verify before relying on any detail.
 *
 *   POST https://openrouter.ai/api/alpha/decisions
 *   { "model": "typesafe/jev-1.13",
 *     "state": { "<key>": "<string>" },
 *     "questions": { "<id>": { "type": "choice"|"score"|"noul",
 *                              "instructions": "<string>",
 *                              "criteria": … } } }
 *
 *   `questions` is a RECORD KEYED BY ID — not an array, and there is no `id`
 *   field inside. `criteria` is a record (option → description) for `choice`, a
 *   STRING array (labelled scale points) for `score`, and omitted for `noul`.
 *   Array elements must be strings: `[1, 10]` is rejected.
 *
 *   The response's `answers` is likewise a record keyed by id, each entry
 *   carrying its value under its OWN kind's field name (`choice` / `score` /
 *   `noul`, never `value`), a `probabilities` map (never `distribution`), and —
 *   for choice/score only — a `confidence`. `usage` is
 *   `input_tokens`/`output_tokens`/`cost`, not the OpenAI-style snake_case pair.
 *   Every one of those is adapted back to the `JevAnswer[]` shape below so no
 *   consumer of this module had to change.
 *
 * 🔴 `allowFallbacks: false` IS GONE, and its replacement is `assertPinnedModel`.
 * The decisions endpoint's proven request shape is `{ model, state, questions }`
 * only; sending an unverified `provider` key to a strictly-validated alpha
 * endpoint risks exactly the 400 this rewrite exists to remove. So the model pin
 * is enforced on the RESPONSE instead: the vendor reports which build answered
 * (`typesafe/jev-1.13-20260917` for the pinned `typesafe/jev-1.13`), and a
 * response from anything that is not the pin or a dated build of it fails
 * closed. That is a strictly stronger guard than the request flag it replaces —
 * it observes what actually ran rather than asking for a routing promise.
 *
 * Fail-closed contract: every parse below THROWS on any violation (an answer
 * whose `type` disagrees with the question, unknown answer keys, an option
 * outside the question's option set, a distribution that does not sum to ~1, a
 * score outside its rubric, a non-2xx status, a model that is not the pin,
 * timeout). Callers catch and degrade — they never receive a partially-valid
 * answer.
 *
 * Model pin: `AI_MODELS.JEV` (numbered). The numbering is not stylistic:
 * measured 2026-09-30, `typesafe/jev-1.13` resolves (one endpoint, 32k ctx)
 * while `typesafe/jev-latest` returns 404.
 */

export const JEV_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

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
  /**
   * The rubric the vendor scores against, one labelled scale point per step
   * from `min` to `max` inclusive — so `criteria.length` MUST equal
   * `max - min + 1`, and `askJev` refuses the request otherwise.
   *
   * 🔴 That guard is the whole reason `criteria` is required rather than
   * optional. The wire carries ONLY `criteria`: the vendor scores in INDEX
   * space (`0 … criteria.length - 1`) and knows nothing of `min`/`max`, so the
   * adapter maps back with `score + min`. If the two disagree, every answer is
   * silently rescaled — a 1–10 question asked with 3 criteria returns ~0–2 and
   * reads as a uniformly terrible score. Rescaling cannot fail loudly on its
   * own, so it is made to fail loudly here.
   */
  criteria: readonly string[];
  /**
   * Round the mapped value to an integer. Set it when the CONSUMER needs an
   * integer (a `z.number().int()` column or schema) — never inferred from the
   * rubric, because a fractional score over an integer rubric is a legitimate
   * answer for a float consumer.
   */
  integer?: boolean;
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
  // 🔴 NO `confidence` on the noul variant, deliberately. The vendor does not
  // return one for a noul — the recorded 200's `needsResource` answer carries
  // `{type, noul}` and nothing else — and a `?? 0` default would pin any
  // aggregate over a noul-containing answer set to zero. Omitting the field
  // from the TYPE makes that absence a compile error at any consumer that
  // reads it, instead of a silent `undefined`.
  | { id: string; type: 'noul'; value: number };

export type JevResponse = {
  answers: JevAnswer[];
  /** The build the VENDOR reports answered, e.g. `typesafe/jev-1.13-20260917`. */
  model: string;
  usage: TokenUsage;
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
// (one measured decisions call over 3 questions: 245ms) and the resource-intent
// p95 target is 2s end-to-end including the matcher.
export const JEV_TIMEOUT_MS = 2000;
// Distributions are full-probability; a float-rounding drift up to this much is
// tolerated, anything else is malformed.
export const JEV_DISTRIBUTION_SUM_TOLERANCE = 0.02;
export const JEV_MAX_CHOICE_OPTIONS = 255;

// How much of a non-2xx body rides along in the `transport` error. The vendor's
// endpoint/model mismatch message is ~130 chars and naming it is the difference
// between "Jev is broken" and a diagnosis, so this must not clip it.
const ERROR_BODY_EXCERPT = 400;

// Per-kind wire key whitelists. `legend` (score) is the vendor's index→criterion
// map; it is accepted and ignored — `criteria` is already the authority on it,
// and the adapter needs no second copy.
//
// 🔴 `noul` does NOT list `confidence`, and that is a deliberate trade with a
// real cost. The recorded 200 returns `{type, noul}` for a noul and nothing
// else, and this module's contract is to reject unknown answer keys (the
// alternative — accept and ignore — would make a future vendor addition
// invisible rather than merely inconvenient). The cost: if this ALPHA endpoint
// starts returning a noul confidence, every call degrades until this set gains
// the key. That is one line, and the degrade is loud. Do not widen it to a
// wildcard.
const WIRE_KEYS: Record<JevQuestionSpec['type'], ReadonlySet<string>> = {
  choice: new Set(['type', 'choice', 'probabilities', 'confidence']),
  score: new Set(['type', 'score', 'probabilities', 'confidence', 'legend']),
  noul: new Set(['type', 'noul']),
};

function fail(kind: JevError['kind'], message: string): never {
  throw new JevError(kind, message);
}

/** The rubric must describe every step from `min` to `max` inclusive. */
export function scoreCriteriaCount(question: JevScoreQuestion): number {
  return question.max - question.min + 1;
}

function parseConfidence(record: Record<string, unknown>, idPath: string): number | undefined {
  if (record.confidence === undefined) return undefined;
  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)) {
    fail('malformed', `confidence for "${idPath}" is not a finite number`);
  }
  return record.confidence;
}

function parseAnswer(question: JevQuestionSpec, raw: unknown, idPath: string): JevAnswer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('malformed', `answer for "${idPath}" is not an object`);
  }
  const record = raw as Record<string, unknown>;
  // The vendor echoes the discriminator. Cross-checking it is free and catches a
  // per-question desync (an answer set shifted onto the wrong ids) that every
  // value-range check below would otherwise pass.
  //
  // 🔴 BEFORE the key whitelist, deliberately. A mismatched answer also carries
  // the WRONG KIND'S keys, so checking keys first reports the symptom
  // (`unknown answer key "score"`) and buries the diagnosis.
  if (record.type !== question.type) {
    fail(
      'malformed',
      `answer for "${idPath}" has type "${String(record.type)}", expected "${question.type}"`
    );
  }
  const allowed = WIRE_KEYS[question.type];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail('malformed', `unknown answer key "${key}" for question "${idPath}"`);
    }
  }

  switch (question.type) {
    case 'choice': {
      const confidence = parseConfidence(record, idPath);
      const options = new Set<string>(question.options);
      if (typeof record.choice !== 'string' || !options.has(record.choice)) {
        fail('malformed', `answer value for "${idPath}" is not one of the offered options`);
      }
      const probabilities = record.probabilities;
      if (
        probabilities === null ||
        typeof probabilities !== 'object' ||
        Array.isArray(probabilities)
      ) {
        fail('malformed', `distribution for "${idPath}" is missing or not an object`);
      }
      const entries = Object.entries(probabilities as Record<string, unknown>);
      if (entries.length === 0) {
        fail('malformed', `distribution for "${idPath}" is empty`);
      }
      let sum = 0;
      const distribution: Record<string, number> = {};
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
        distribution[option] = probability;
        sum += probability;
      }
      if (Math.abs(sum - 1) > JEV_DISTRIBUTION_SUM_TOLERANCE) {
        fail('malformed', `distribution for "${idPath}" sums to ${sum}, expected ~1`);
      }
      return { id: question.id, type: 'choice', value: record.choice, distribution, confidence };
    }
    case 'score': {
      const confidence = parseConfidence(record, idPath);
      const { score } = record;
      // INDEX SPACE: the vendor answers `0 … criteria.length - 1`, never the
      // declared `min`/`max` — which it is never told. `askJev` has already
      // proven `criteria.length === max - min + 1`, so this bound and the
      // declared range are the same interval expressed twice.
      const lastIndex = scoreCriteriaCount(question) - 1;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > lastIndex) {
        fail('malformed', `score for "${idPath}" is not a number in [0,${lastIndex}]`);
      }
      const value = (question.integer ? Math.round(score) : score) + question.min;
      if (value < question.min || value > question.max) {
        fail(
          'malformed',
          `score for "${idPath}" maps to ${value}, outside [${question.min},${question.max}]`
        );
      }
      return { id: question.id, type: 'score', value, confidence };
    }
    case 'noul': {
      const { noul } = record;
      if (typeof noul !== 'number' || !Number.isFinite(noul) || noul < 0 || noul > 1) {
        fail('malformed', `noul for "${idPath}" is not a probability in [0,1]`);
      }
      return { id: question.id, type: 'noul', value: noul };
    }
  }
}

/**
 * The confidence to record for one row derived from a whole answer set: the MIN
 * across the answers that CARRY one. The weakest judgment bounds the row.
 *
 * 🔴 `noul` answers carry no confidence and are EXCLUDED, not defaulted. A
 * `?? 0` would pin every row containing a noul to 0 — and both of this repo's
 * question specs contain one.
 *
 * `null` when no answer in the set carries a confidence (an all-noul set), so
 * the caller writes an honest absence rather than a floor it invented.
 */
export function jevConfidenceFloor(answers: readonly JevAnswer[]): number | null {
  let floor: number | null = null;
  for (const answer of answers) {
    if (answer.type === 'noul') continue;
    if (answer.confidence === undefined) continue;
    floor = floor === null ? answer.confidence : Math.min(floor, answer.confidence);
  }
  return floor;
}

type WireQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };

/**
 * Build the `questions` RECORD the decisions endpoint takes. Exported so a test
 * can read the wire body without reaching into `fetch`'s arguments.
 */
export function buildDecisionsQuestions(
  questions: readonly JevQuestionSpec[]
): Record<string, WireQuestion> {
  const wire: Record<string, WireQuestion> = {};
  for (const question of questions) {
    switch (question.type) {
      case 'choice':
        wire[question.id] = {
          type: 'choice',
          instructions: question.prompt,
          // The vendor chooses among the KEYS, so the key set is the option set
          // and that is the load-bearing half. Each option describes itself
          // until a caller has something better to say about it; the semantics
          // live in `instructions`.
          criteria: Object.fromEntries(question.options.map((option) => [option, option])),
        };
        break;
      case 'score':
        wire[question.id] = {
          type: 'score',
          instructions: question.prompt,
          // 🔴 Strings, never numbers — `[1, 10]` is rejected by the endpoint.
          criteria: question.criteria.map(String),
        };
        break;
      case 'noul':
        // No `criteria` key at all for a noul — not an empty one.
        wire[question.id] = { type: 'noul', instructions: question.prompt };
        break;
    }
  }
  return wire;
}

/**
 * The response must come from the pinned model or a dated build of it. This is
 * the replacement for the `allowFallbacks: false` request flag the chat
 * transport could send and the decisions endpoint has no proven equivalent for.
 */
function assertPinnedModel(model: unknown): string {
  if (typeof model !== 'string' || !model) {
    fail('malformed', 'Jev response carries no model');
  }
  if (model !== AI_MODELS.JEV && !model.startsWith(`${AI_MODELS.JEV}-`)) {
    fail('malformed', `Jev response came from "${model}", not the pinned ${AI_MODELS.JEV}`);
  }
  return model;
}

function parseUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const cost = usage.cost;
  return {
    promptTokens: num(usage.input_tokens),
    completionTokens: num(usage.output_tokens),
    // The vendor reports per-call spend, so a batch pass can meter itself
    // instead of estimating. Absent rather than 0 when the vendor omits it — a
    // real $0 and "not reported" are different facts.
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  };
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
    if (question.type === 'score') {
      const expected = scoreCriteriaCount(question);
      if (expected < 2) {
        fail(
          'malformed',
          `score "${question.id}" declares range [${question.min},${question.max}], which is not a scale`
        );
      }
      if (question.criteria.length !== expected) {
        fail(
          'malformed',
          `score "${question.id}" has ${question.criteria.length} criteria but range [${question.min},${question.max}] needs ${expected}`
        );
      }
    }
  }

  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    fail('not-configured', 'OPENROUTER_API_KEY is not configured');
  }

  const timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
  // The timer ABORTS the request itself, so a timed-out call does not hold its
  // connection open; the Promise.race is the belt for a fetch implementation
  // that ever ignores the signal.
  const abortController = new AbortController();
  const timer = setTimeout(
    () => abortController.abort(new JevError('timeout', `Jev call exceeded ${timeoutMs}ms`)),
    timeoutMs
  );

  let payload: unknown;
  try {
    const response = await Promise.race([
      fetch(JEV_DECISIONS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        // 🔴 EXACTLY these three keys. The shape is the one proven by a 200;
        // the endpoint validates strictly and this is an alpha API, so do not
        // add `temperature` / `max_tokens` / `response_format` / `provider`
        // here on the assumption that a chat parameter carries over. None of
        // them has been observed to be accepted.
        body: JSON.stringify({
          model: AI_MODELS.JEV,
          state: request.state,
          questions: buildDecisionsQuestions(request.questions),
        }),
        signal: abortController.signal,
      }),
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

    const body = await response.text();
    if (!response.ok) {
      // 🔴 A non-2xx must name the vendor's own message. The defect this file
      // was rewritten to fix presented as an empty suggestion list; the body
      // said precisely what was wrong.
      fail(
        'transport',
        `Jev decisions call failed with ${response.status}: ${body.slice(0, ERROR_BODY_EXCERPT)}`
      );
    }
    try {
      payload = JSON.parse(body);
    } catch {
      fail('malformed', 'Jev response body is not JSON');
    }
  } catch (error) {
    if (error instanceof JevError) throw error;
    if (abortController.signal.aborted) {
      throw new JevError('timeout', `Jev call exceeded ${timeoutMs}ms`);
    }
    fail('transport', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('malformed', 'Jev response is not a JSON object');
  }
  const envelope = payload as Record<string, unknown>;
  const model = assertPinnedModel(envelope.model);
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
  // Ordered by the REQUEST's questions, so a caller may index positionally.
  const answers = request.questions.map((question) =>
    parseAnswer(question, answersById[question.id], question.id)
  );

  return { answers, model, usage: parseUsage(envelope.usage) };
}

/*
 * There is deliberately NO direct-`api.typesafe.ai` seam here. An earlier draft
 * shipped one as a function that only ever threw, plus a `TYPESAFE_API_KEY` env
 * entry nothing read. It bought nothing: `askJev` is already the interface a
 * transport swap would replace, and the direct path additionally needs a SOPS
 * secret and an egress decision that no stub can pre-make. Add it when it is
 * wired, not before.
 */
