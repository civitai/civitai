import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setEnv } from '~/__tests__/mocks';
import { AI_MODELS } from '~/server/services/ai/openrouter';

/**
 * Contract tests for the Jev vendor seam — `POST /api/alpha/decisions`.
 *
 * 🔴 WHY THIS FILE WAS REWRITTEN. Its predecessor was comprehensive, green, and
 * tested a transport that returned HTTP 400 on every call in production for its
 * whole life. It mocked `openrouter.chat.send`, so every fixture it asserted
 * against was a shape the vendor would never send: `typesafe/jev-1.13` is a
 * DECISIONS model and chat/completions refuses it outright. A green suite over
 * a mocked seam is a claim about the mock.
 *
 * So this file is built the other way round:
 *
 *  1. `RECORDED_200` below is the VERBATIM body of a real, paid-for 200 from
 *     the live endpoint (3 questions, 245ms, $0.0000197). Nothing in it was
 *     written from the implementation. Every adapter assertion replays it.
 *  2. The QUESTION SPECS are derived from that recording wherever the recording
 *     constrains them — the choice options are the keys of its own
 *     `probabilities` map, the score rubric is its own `legend` in index order.
 *  3. The seam mocked is `fetch`, the lowest one available. That makes the
 *     REQUEST (url, method, headers, body shape) assertable, which is precisely
 *     the half the old suite could not see.
 */

const fetchMock = vi.fn();

/**
 * 🔴 VERBATIM. Recorded 2026-10-01 against
 * `POST https://openrouter.ai/api/alpha/decisions`. Do not "tidy" it, do not
 * re-derive it from the parser, and do not add fields to make a test pass —
 * including `id` and `provider`, which the old implementation's
 * "unknown top-level key" check would have rejected (one more reason it could
 * never have worked against reality).
 */
const RECORDED_200 = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    role: {
      type: 'choice',
      choice: 'character',
      probabilities: { none: 0.02, concept: 0.13, character: 0.47, style: 0.38 },
      confidence: 0.29,
    },
    quality: {
      type: 'score',
      score: 1.94,
      legend: {
        '0': '1 = the prompt names no style at all',
        '1': '5 = a style is implied but vague',
        '2': '10 = the style is named precisely and unambiguously',
      },
      probabilities: { '0': 0.01, '1': 0.04, '2': 0.95 },
      confidence: 0.91,
    },
    needsResource: { type: 'noul', noul: 0.28 },
  },
  usage: { input_tokens: 470, output_tokens: 78, cost: 1.974e-5 },
  id: 'gen-dec-1790908548-xi9OsUSY1H89EbqOnvpp',
  provider: 'TypeSafe',
} as const;

/** The 400 the previous implementation received on every call it ever made. */
const DECISIONS_MODEL_400 =
  'typesafe/jev-1.13 is a decisions model and cannot be used with the chat/completions endpoint. Use the /api/alpha/decisions endpoint instead.';

const {
  askJev,
  buildDecisionsQuestions,
  jevConfidenceFloor,
  scoreCriteriaCount,
  JevError,
  JEV_DECISIONS_URL,
  JEV_TIMEOUT_MS,
} = await import('~/server/services/ai/jev');

// ── Question specs, derived from the recording ──────────────────────────────

/** Options ARE the keys of the recorded distribution — not a hand-written set. */
const RECORDED_ROLE_OPTIONS = Object.keys(RECORDED_200.answers.role.probabilities);
/** The rubric IS the recorded legend, in index order. */
const RECORDED_QUALITY_CRITERIA = Object.keys(RECORDED_200.answers.quality.legend)
  .sort((a, b) => Number(a) - Number(b))
  .map((k) => RECORDED_200.answers.quality.legend[k as '0' | '1' | '2']);

const roleQuestion = {
  id: 'role',
  type: 'choice' as const,
  prompt: 'What role?',
  options: RECORDED_ROLE_OPTIONS,
};
/**
 * min/max chosen to MATCH the recording's criteria count, which is what the
 * `criteria.length === max - min + 1` guard requires. The probe that produced
 * this recording asked a 1–10 question with 3 criteria — a live misconfiguration
 * the guard now refuses outright (pinned below).
 */
const qualityQuestion = {
  id: 'quality',
  type: 'score' as const,
  prompt: 'How precisely is the style named?',
  min: 1,
  max: 3,
  criteria: RECORDED_QUALITY_CRITERIA,
};
const needsResourceQuestion = {
  id: 'needsResource',
  type: 'noul' as const,
  prompt: 'Would this benefit from a resource?',
};
const recordedQuestions = [roleQuestion, qualityQuestion, needsResourceQuestion] as const;

/** 5 criteria over [1,5] with integer rounding — the shape `specificity` uses. */
const specificityQuestion = {
  id: 'specificity',
  type: 'score' as const,
  prompt: 'How specific?',
  min: 1,
  max: 5,
  criteria: ['a', 'b', 'c', 'd', 'e'],
  integer: true,
};

function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  fetchMock.mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

/**
 * Reply with the recording's own envelope — its `model` and `usage` — carrying
 * exactly the answers given. Used for the single-question cases: an answer for
 * a question that was not asked is itself a fail-closed violation, so a
 * three-answer envelope would mask whatever the case is actually about.
 */
function respondAnswers(answers: Record<string, unknown>) {
  respond({ model: RECORDED_200.model, answers, usage: RECORDED_200.usage });
}

function lastRequestBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(init.body);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  setEnv({ OPENROUTER_API_KEY: 'test-openrouter-key' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ───────────────────────────────────────────────────────────────────────────────
describe('🔴 askJev talks to the DECISIONS endpoint', () => {
  /**
   * The regression. `typesafe/jev-1.13` cannot be used with chat/completions;
   * the previous implementation called exactly that and 400'd on every request
   * in production. These assertions are the ones no amount of response-shape
   * coverage could have made.
   */
  it('exports the alpha decisions URL and not a chat/completions one', () => {
    expect(JEV_DECISIONS_URL).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(JEV_DECISIONS_URL).not.toContain('chat/completions');
  });

  it('POSTs to the decisions URL with a bearer key and a JSON content type', async () => {
    respond(RECORDED_200);
    await askJev({ state: { prompt: 'p' }, questions: recordedQuestions });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> }
    ];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(url).not.toContain('chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer test-openrouter-key');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sends EXACTLY model + state + questions, and no chat parameters', async () => {
    respond(RECORDED_200);
    await askJev({ state: { prompt: 'a red sports car' }, questions: recordedQuestions });

    const body = lastRequestBody();
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'].sort());
    expect(body.state).toEqual({ prompt: 'a red sports car' });
    // Each of these was sent by the broken chat transport; none is known to be
    // accepted here, and an alpha endpoint that validates strictly is exactly
    // where an unverified extra key costs a 400.
    for (const key of [
      'messages',
      'temperature',
      'max_tokens',
      'maxTokens',
      'response_format',
      'responseFormat',
      'provider',
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends the numbered pin and never `jev-latest`', async () => {
    respond(RECORDED_200);
    await askJev({ state: {}, questions: recordedQuestions });
    const body = lastRequestBody();
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.model).toBe(AI_MODELS.JEV);
    expect(String(body.model)).not.toContain('latest');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('🔴 the wire `questions` payload is a RECORD keyed by id', () => {
  it('keys questions by id, carries `instructions`, and has no `id`/`prompt` field inside', () => {
    const wire = buildDecisionsQuestions(recordedQuestions);
    expect(Array.isArray(wire)).toBe(false);
    expect(Object.keys(wire).sort()).toEqual(['needsResource', 'quality', 'role']);
    for (const [id, q] of Object.entries(wire)) {
      expect(q).not.toHaveProperty('id');
      expect(q).not.toHaveProperty('prompt');
      expect(q.instructions).toBe(
        recordedQuestions.find((candidate) => candidate.id === id)!.prompt
      );
    }
  });

  it('a choice question sends `criteria` as a RECORD whose keys are the options', () => {
    const wire = buildDecisionsQuestions([roleQuestion]);
    const q = wire.role as { type: string; criteria: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(Array.isArray(q.criteria)).toBe(false);
    expect(Object.keys(q.criteria)).toEqual(RECORDED_ROLE_OPTIONS);
    expect(q).not.toHaveProperty('options');
  });

  it('a score question sends `criteria` as a STRING ARRAY and never min/max', () => {
    const wire = buildDecisionsQuestions([qualityQuestion]);
    const q = wire.quality as { type: string; criteria: unknown };
    expect(q.type).toBe('score');
    expect(Array.isArray(q.criteria)).toBe(true);
    expect(q.criteria).toEqual(RECORDED_QUALITY_CRITERIA);
    // 🔴 `[1, 10]` is rejected by the endpoint — every element must be a string.
    for (const c of q.criteria as unknown[]) expect(typeof c).toBe('string');
    expect(q).not.toHaveProperty('min');
    expect(q).not.toHaveProperty('max');
    expect(q).not.toHaveProperty('integer');
  });

  it('a noul question sends NO `criteria` key at all', () => {
    const wire = buildDecisionsQuestions([needsResourceQuestion]);
    expect(wire.needsResource).toEqual({
      type: 'noul',
      instructions: needsResourceQuestion.prompt,
    });
    expect(wire.needsResource).not.toHaveProperty('criteria');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('🔴 the RECORDED 200 adapts to the JevAnswer contract', () => {
  it('maps every answer kind, the vendor model, and usage including cost', async () => {
    respond(RECORDED_200);
    const result = await askJev({ state: { prompt: 'p' }, questions: recordedQuestions });

    // The vendor-reported BUILD, not the request pin — the only thing that can
    // show which model actually answered now that `allowFallbacks` is gone.
    expect(result.model).toBe('typesafe/jev-1.13-20260917');
    expect(result.model).not.toBe(AI_MODELS.JEV);

    expect(result.usage).toEqual({
      promptTokens: 470,
      completionTokens: 78,
      costUsd: 1.974e-5,
    });

    // Order follows the REQUEST's questions.
    expect(result.answers.map((a) => a.id)).toEqual(['role', 'quality', 'needsResource']);

    const [role, quality, needsResource] = result.answers;
    expect(role).toEqual({
      id: 'role',
      type: 'choice',
      // from `choice`, NOT `value`
      value: 'character',
      // from `probabilities`, NOT `distribution`
      distribution: { none: 0.02, concept: 0.13, character: 0.47, style: 0.38 },
      confidence: 0.29,
    });
    // 1.94 in index space + min 1, unrounded — the question declares no `integer`.
    expect(quality).toEqual({ id: 'quality', type: 'score', value: 2.94, confidence: 0.91 });
    // from `noul`, and 0.28 is a PROBABILITY, not a 0/1.
    expect(needsResource).toEqual({ id: 'needsResource', type: 'noul', value: 0.28 });
  });

  it('🔴 a noul answer carries NO `confidence` property — not even undefined', async () => {
    respond(RECORDED_200);
    const result = await askJev({ state: {}, questions: recordedQuestions });
    const noul = result.answers.find((a) => a.id === 'needsResource')!;
    expect(Object.keys(noul).sort()).toEqual(['id', 'type', 'value']);
    expect('confidence' in noul).toBe(false);
  });

  it("accepts the recording's extra top-level keys (`id`, `provider`)", async () => {
    // The old parser allowed exactly ONE top-level key, `answers`. The real
    // response has five. Any re-tightening of that check breaks every call.
    expect(Object.keys(RECORDED_200)).toContain('id');
    expect(Object.keys(RECORDED_200)).toContain('provider');
    respond(RECORDED_200);
    await expect(askJev({ state: {}, questions: recordedQuestions })).resolves.toHaveProperty(
      'answers'
    );
  });

  it('keeps a distribution within the float tolerance, values intact', async () => {
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        // sums to 0.999 — inside the 0.02 tolerance
        probabilities: { none: 0.02, concept: 0.13, character: 0.47, style: 0.379 },
      },
    });
    const result = await askJev({ state: {}, questions: [roleQuestion] });
    expect(result.answers[0]).toMatchObject({
      distribution: { none: 0.02, concept: 0.13, character: 0.47, style: 0.379 },
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('🔴 score mapping: index space → the declared range', () => {
  it('scoreCriteriaCount is max - min + 1', () => {
    expect(scoreCriteriaCount(qualityQuestion)).toBe(3);
    expect(scoreCriteriaCount(specificityQuestion)).toBe(5);
  });

  it('`integer: true` rounds, then offsets by min — 1.94 → 3 over [1,5]', async () => {
    respond({
      model: RECORDED_200.model,
      answers: {
        specificity: { type: 'score', score: RECORDED_200.answers.quality.score, confidence: 0.91 },
      },
      usage: RECORDED_200.usage,
    });
    const result = await askJev({ state: {}, questions: [specificityQuestion] });
    // Math.round(1.94) = 2, + min 1 = 3. NOT 2.94, and NOT 1.94.
    expect(result.answers[0]).toEqual({
      id: 'specificity',
      type: 'score',
      value: 3,
      confidence: 0.91,
    });
    expect(Number.isInteger((result.answers[0] as { value: number }).value)).toBe(true);
  });

  it('without `integer` the value keeps its fraction — 1.94 → 2.94 over [1,3]', async () => {
    respondAnswers({ quality: RECORDED_200.answers.quality });
    const result = await askJev({ state: {}, questions: [qualityQuestion] });
    expect((result.answers[0] as { value: number }).value).toBe(2.94);
  });

  it('the offset is `min`, not a hardcoded 1 — min 4 over [4,6] shifts by 4', async () => {
    const shifted = { ...qualityQuestion, id: 'shifted', min: 4, max: 6 };
    respond({
      model: RECORDED_200.model,
      answers: { shifted: { type: 'score', score: 2 } },
      usage: RECORDED_200.usage,
    });
    const result = await askJev({ state: {}, questions: [shifted] });
    expect((result.answers[0] as { value: number }).value).toBe(6);
  });

  it('index 0 maps to min and the last index maps to max', async () => {
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: 0 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).resolves.toMatchObject({
      answers: [{ value: 1 }],
    });
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: 4 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).resolves.toMatchObject({
      answers: [{ value: 5 }],
    });
  });

  it('🔴 refuses a criteria count that disagrees with the range, before any call', async () => {
    // EXACTLY the probe that produced RECORDED_200: a 1–10 question answered
    // over 3 criteria. It returned 1.94, which reads as "terrible" on a 1–10
    // scale and is actually "mid" on a 3-point one. Nothing about that rescale
    // can fail on its own, so it fails here.
    const mismatched = { ...qualityQuestion, min: 1, max: 10 };
    await expect(askJev({ state: {}, questions: [mismatched] })).rejects.toMatchObject({
      name: 'JevError',
      kind: 'malformed',
      message: expect.stringContaining('has 3 criteria but range [1,10] needs 10'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a score range that is not a scale', async () => {
    const flat = { ...qualityQuestion, min: 2, max: 2, criteria: ['only'] };
    await expect(askJev({ state: {}, questions: [flat] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not a scale'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a score outside index space', async () => {
    respondAnswers({ quality: { type: 'score', score: 3 } });
    await expect(askJev({ state: {}, questions: [qualityQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('is not a number in [0,2]'),
    });
  });

  it('rejects a non-finite score', async () => {
    respondAnswers({ quality: { type: 'score', score: null } });
    await expect(askJev({ state: {}, questions: [qualityQuestion] })).rejects.toBeInstanceOf(
      JevError
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('🔴 jevConfidenceFloor — the weakest judgment bounds the row', () => {
  it('is the MIN over the answers that carry a confidence', async () => {
    respond(RECORDED_200);
    const result = await askJev({ state: {}, questions: recordedQuestions });
    // role 0.29, quality 0.91, needsResource none.
    expect(jevConfidenceFloor(result.answers)).toBe(0.29);
  });

  it('🔴 a noul does NOT contribute — a 0-floor would otherwise pin every row', () => {
    const floor = jevConfidenceFloor([
      { id: 'a', type: 'noul', value: 0 },
      { id: 'b', type: 'score', value: 4, confidence: 0.8 },
    ]);
    expect(floor).toBe(0.8);
  });

  it('returns null when nothing in the set carries a confidence', () => {
    expect(
      jevConfidenceFloor([
        { id: 'a', type: 'noul', value: 0.28 },
        { id: 'b', type: 'noul', value: 0.9 },
      ])
    ).toBeNull();
    expect(jevConfidenceFloor([])).toBeNull();
  });

  it('skips a choice/score answer whose confidence the vendor omitted', () => {
    expect(
      jevConfidenceFloor([
        { id: 'a', type: 'choice', value: 'x', distribution: { x: 1 } },
        { id: 'b', type: 'score', value: 2, confidence: 0.4 },
      ])
    ).toBe(0.4);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('askJev — fail-closed on the response', () => {
  it('🔴 a non-2xx surfaces as `transport` carrying the VENDOR message', async () => {
    respond(DECISIONS_MODEL_400, { ok: false, status: 400 });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      name: 'JevError',
      kind: 'transport',
      message: expect.stringContaining('400'),
    });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      message: expect.stringContaining('is a decisions model'),
    });
  });

  it('🔴 a response from a DIFFERENT model fails closed', async () => {
    // The structural replacement for `provider.allowFallbacks: false`, which the
    // decisions request shape has no proven equivalent for.
    respond({ ...RECORDED_200, model: 'openai/gpt-4o-mini' });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not the pinned typesafe/jev-1.13'),
    });
  });

  it('accepts a DATED build of the pin, rejects a longer sibling id', async () => {
    respond({ ...RECORDED_200, model: 'typesafe/jev-1.13-20270101' });
    await expect(askJev({ state: {}, questions: recordedQuestions })).resolves.toHaveProperty(
      'model',
      'typesafe/jev-1.13-20270101'
    );

    respond({ ...RECORDED_200, model: 'typesafe/jev-1.130' });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
    });
  });

  it('rejects a missing model', async () => {
    const { model, ...withoutModel } = RECORDED_200;
    respond(withoutModel);
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('carries no model'),
    });
  });

  it('🔴 rejects an answer whose `type` disagrees with the question', async () => {
    respondAnswers({ role: { type: 'score', score: 1 } });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('expected "choice"'),
    });
  });

  it('rejects a non-JSON body', async () => {
    respond('I would say character, probably');
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not JSON'),
    });
  });

  it('rejects an answer for an unknown question id', async () => {
    respond({
      ...RECORDED_200,
      answers: { ...RECORDED_200.answers, hallucinated: { type: 'noul', noul: 1 } },
    });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown answer key "hallucinated"'),
    });
  });

  it('rejects a missing answer for a question that was asked', async () => {
    respond({ ...RECORDED_200, answers: { role: RECORDED_200.answers.role } });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('is not an object'),
    });
  });

  it('rejects an unknown key inside an answer object', async () => {
    respondAnswers({ role: { ...RECORDED_200.answers.role, reasoning: 'because' } });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown answer key "reasoning"'),
    });
  });

  it('🔴 rejects a `confidence` on a noul rather than silently dropping it', async () => {
    // Fail-closed, deliberately: the recording carries none, and accepting-and-
    // ignoring would make a vendor change invisible. One-line fix if it happens.
    respondAnswers({ needsResource: { type: 'noul', noul: 0.28, confidence: 0.5 } });
    await expect(askJev({ state: {}, questions: [needsResourceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown answer key "confidence"'),
    });
  });

  it('rejects a choice outside the offered options', async () => {
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'wildcard',
        probabilities: { character: 1 },
      },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not one of the offered options'),
    });
  });

  it('rejects a distribution naming an option that was not offered', async () => {
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        probabilities: { character: 0.5, pose: 0.5 },
      },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown option "pose"'),
    });
  });

  it('rejects a distribution that does not sum to ~1', async () => {
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        probabilities: { none: 0.02, concept: 0.13, character: 0.47 },
      },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('sums to'),
    });
  });

  it('rejects a distribution probability outside [0,1]', async () => {
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        probabilities: { character: 1.4 },
      },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not in [0,1]'),
    });
  });

  it('rejects a missing or empty distribution', async () => {
    respondAnswers({ role: { type: 'choice', choice: 'character' } });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      message: expect.stringContaining('missing or not an object'),
    });
    respondAnswers({ role: { type: 'choice', choice: 'character', probabilities: {} } });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      message: expect.stringContaining('is empty'),
    });
  });

  it('rejects a non-finite confidence', async () => {
    for (const bad of ['Infinity-ish', null]) {
      respondAnswers({ role: { ...RECORDED_200.answers.role, confidence: bad } });
      await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
        kind: 'malformed',
        message: expect.stringContaining('confidence'),
      });
    }
  });

  it('rejects a noul outside [0,1]', async () => {
    respondAnswers({ needsResource: { type: 'noul', noul: 1.5 } });
    await expect(askJev({ state: {}, questions: [needsResourceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('[0,1]'),
    });
  });

  it('rejects an answers field that is not an object', async () => {
    respond({ ...RECORDED_200, answers: [] });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('missing an answers object'),
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('askJev — fail-closed on the request, before any spend', () => {
  it('rejects an empty question list', async () => {
    await expect(askJev({ state: {}, questions: [] })).rejects.toBeInstanceOf(JevError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a duplicate question id', async () => {
    await expect(
      askJev({ state: {}, questions: [roleQuestion, { ...roleQuestion }] })
    ).rejects.toMatchObject({ message: expect.stringContaining('duplicate question id') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a choice with fewer than 2 options', async () => {
    await expect(
      askJev({ state: {}, questions: [{ ...roleQuestion, options: ['only'] }] })
    ).rejects.toMatchObject({ message: expect.stringContaining('>=2 options') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a choice with more than 255 options', async () => {
    const tooMany = {
      id: 'big',
      type: 'choice' as const,
      prompt: 'pick',
      options: Array.from({ length: 256 }, (_, i) => String(i)),
    };
    await expect(askJev({ state: {}, questions: [tooMany] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('255'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails `not-configured` with no API key, and calls nothing', async () => {
    setEnv({ OPENROUTER_API_KEY: undefined });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'not-configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('askJev — timeout and transport', () => {
  it('throws the timeout JevError when the vendor never answers', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 10_000))
    );
    const pending = askJev({ state: {}, questions: recordedQuestions });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 10);
    await assertion;
  }, 5000);

  it('aborts the underlying request on timeout', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        })
    );
    const pending = askJev({ state: {}, questions: recordedQuestions });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 10);
    await assertion;
    const [, init] = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(init.signal.aborted).toBe(true);
  }, 5000);

  it('throws the transport JevError when fetch itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'transport',
      message: expect.stringContaining('ECONNRESET'),
    });
  });
});
