import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setEnv } from '~/__tests__/mocks';
import { RESOURCE_INTENT_QUESTIONS } from '~/server/schema/resource-intent.schema';
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
    // Each of these was sent by the broken chat transport. The endpoint ignores
    // an undeclared key with a 200, so sending one would read as configured while
    // doing nothing; `provider` is sent only on an explicit zero-retention opt-in.
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

  it('🔴 sends provider.zdr only when zero data retention is requested', async () => {
    respond(RECORDED_200);
    await askJev(
      { state: { prompt: 'p' }, questions: recordedQuestions },
      { zeroDataRetention: true }
    );
    expect(lastRequestBody().provider).toEqual({ zdr: true });

    respond(RECORDED_200);
    await askJev({ state: { prompt: 'p' }, questions: recordedQuestions });
    expect(lastRequestBody()).not.toHaveProperty('provider');
  });

  it('carries option descriptions into the wire criteria, and an undescribed option describes itself', () => {
    const wire = buildDecisionsQuestions([
      { ...roleQuestion, optionDescriptions: { character: 'a named character or person' } },
    ]);
    expect(wire.role).toEqual({
      type: 'choice',
      instructions: roleQuestion.prompt,
      criteria: {
        none: 'none',
        concept: 'concept',
        character: 'a named character or person',
        style: 'style',
      },
    });
  });

  it('refuses a description for something that is not an option, before any spend', async () => {
    respond(RECORDED_200);
    await expect(
      askJev({
        state: { prompt: 'p' },
        questions: [{ ...roleQuestion, optionDescriptions: { villain: 'not an option' } }],
      })
    ).rejects.toThrow('describes "villain", which is not an option');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🔴 the `questions` that go ON THE WIRE are a record keyed by id, not an array', async () => {
    // Found by a mutation sweep: every id/record assertion in this file read
    // `buildDecisionsQuestions`'s RETURN VALUE, so wrapping the call site in
    // `Object.values(...)` — mismatch #1, an array instead of a record, the
    // exact shape the endpoint rejects — survived the whole suite. The claim
    // has to be made about the serialised body.
    respond(RECORDED_200);
    await askJev({ state: { prompt: 'p' }, questions: recordedQuestions });
    const { questions } = lastRequestBody();
    expect(Array.isArray(questions)).toBe(false);
    expect(Object.keys(questions as object).sort()).toEqual(['needsResource', 'quality', 'role']);
    expect(questions).toEqual(buildDecisionsQuestions(recordedQuestions));
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
    // 🔴 The VALUES too, literally. Asserting only the key set left
    // `[option, '']` and `[option, question.prompt]` alive — both send the
    // vendor a criteria record whose descriptions are empty or all identical.
    // The "each option describes itself" decision is held here and nowhere else.
    expect(q.criteria).toEqual({
      none: 'none',
      concept: 'concept',
      character: 'character',
      style: 'style',
    });
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

    // If `jev.ts` ever captures `fetch` at module scope, `vi.stubGlobal` stops
    // applying and the response-shape cases below would keep passing against a
    // real 401 while only the happy path went red. A call count is what notices.
    expect(fetchMock).toHaveBeenCalledTimes(1);

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

  it('🔴 accepts the BARE pin as well as a dated build', async () => {
    // Every other fixture answers with a DATED build, so the accepting arm of
    // `assertPinnedModel` (`model !== AI_MODELS.JEV`) was never executed and
    // deleting it left the whole suite green. It is the guard that replaced
    // `allowFallbacks: false`: if the vendor ever stops stamping dates, a
    // missing arm here throws `malformed` on EVERY call and the primitive
    // degrades to empty suggestions exactly as it did before this rewrite.
    respond({ ...RECORDED_200, model: AI_MODELS.JEV });
    await expect(askJev({ state: {}, questions: recordedQuestions })).resolves.toHaveProperty(
      'model',
      AI_MODELS.JEV
    );
  });

  it('🔴 an answer with NO vendor confidence yields no confidence AND a null floor', async () => {
    // The seam. `parseConfidence` returning `0` instead of `undefined` survived
    // the whole suite, because the adapter cases that omit `confidence` asserted
    // only `value`/`distribution`, and the floor case that covers the decision
    // hand-built its `JevAnswer`. Each half was tested; the join was not — and
    // the join is where a `?? 0` pins every row to zero.
    respondAnswers({
      role: { type: 'choice', choice: 'character', probabilities: { character: 1 } },
    });
    const result = await askJev({ state: {}, questions: [roleQuestion] });
    const [answer] = result.answers;
    expect(Object.keys(answer).sort()).toEqual([
      'confidence',
      'distribution',
      'id',
      'type',
      'value',
    ]);
    // The narrowing is the point, not boilerplate: `JevAnswer`'s noul variant has
    // no `confidence` at all, so reading it off the union is a type error. That
    // is the guard working.
    if (answer.type === 'noul') throw new Error('expected a choice answer');
    expect(answer.confidence).toBeUndefined();
    expect(jevConfidenceFloor(result.answers)).toBeNull();
  });

  it('🔴 reports an ABSENT cost as absent, never as 0', async () => {
    // "A real $0 and 'not reported' are different facts" is a claim the module
    // makes in a comment; nothing asserted it, so `costUsd: num(usage.cost)`
    // survived. Use `in`, not `toEqual` — `toEqual` ignores undefined.
    respond({
      model: RECORDED_200.model,
      answers: { needsResource: RECORDED_200.answers.needsResource },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const result = await askJev({ state: {}, questions: [needsResourceQuestion] });
    expect(result.usage.promptTokens).toBe(1);
    expect(result.usage.completionTokens).toBe(2);
    expect('costUsd' in result.usage).toBe(false);
  });

  it('drops a NEGATIVE cost to absent rather than metering it', async () => {
    respond({
      model: RECORDED_200.model,
      answers: { needsResource: RECORDED_200.answers.needsResource },
      usage: { input_tokens: 1, output_tokens: 2, cost: -5 },
    });
    const result = await askJev({ state: {}, questions: [needsResourceQuestion] });
    expect('costUsd' in result.usage).toBe(false);
  });

  it('survives a response with no `usage` at all, with zeros rather than a TypeError', async () => {
    // `(raw ?? {})` was unexercised: no fixture omitted `usage`, so a vendor
    // response without it would have thrown a bare TypeError out of a module
    // whose entire contract is that every violation is a `JevError`.
    respond({
      model: RECORDED_200.model,
      answers: { needsResource: RECORDED_200.answers.needsResource },
    });
    const result = await askJev({ state: {}, questions: [needsResourceQuestion] });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('🔴 orders answers by the REQUEST, not by the response key order', async () => {
    // The recording's `answers` key order happens to equal `recordedQuestions`,
    // so mapping the RESPONSE's keys produced an identical array and survived —
    // the fixture could only ever produce the constant's own value. Asking in a
    // different order is the control.
    respond(RECORDED_200);
    const result = await askJev({
      state: {},
      questions: [needsResourceQuestion, qualityQuestion, roleQuestion],
    });
    expect(result.answers.map((a) => a.id)).toEqual(['needsResource', 'quality', 'role']);
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
    // EXACTLY the probe that produced RECORDED_200: a 1-10 question answered
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

  it('🔴 absorbs the drift the vendor SHOWS us, at the top of the scale', async () => {
    // The recording proves the score is Σ i·pᵢ: 0(0.01)+1(0.04)+2(0.95) = 1.94
    // exactly. Those probabilities are 2dp, which is why the choice path already
    // tolerates a ±0.02 sum drift — and that drift reaches the score multiplied
    // by the index it lands on. `{3:0.01, 4:1.00}` sums to 1.01 (inside the
    // choice tolerance) and yields 4.03 against a lastIndex of 4. A zero-slack
    // bound would reject exactly the prompts the vendor is most certain about.
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: 4.03 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).resolves.toMatchObject({
      answers: [{ value: 5 }],
    });
  });

  it('🔴 CLAMPS into index space — rounding cannot stand in for it', async () => {
    // Both drift cases above use `specificity`, which is `integer: true`, so
    // `Math.round` absorbs the out-of-range value and `const index = score`
    // survives. A FLOAT consumer has no rounding to hide behind: `quality` is
    // [1,3] with slack 0.04, so 2.04 must land on 3 and not on 3.04 — a value
    // outside the range the question declared, handed to a caller that trusts it.
    respondAnswers({ quality: { type: 'score', score: 2.04 } });
    const result = await askJev({ state: {}, questions: [qualityQuestion] });
    expect((result.answers[0] as { value: number }).value).toBe(3);
  });

  it('absorbs the same drift at the BOTTOM of the scale', async () => {
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: -0.05 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).resolves.toMatchObject({
      answers: [{ value: 1 }],
    });
  });

  it('🔴 CLAMPS the LOWER arm too — rounding hides that one as well', async () => {
    // The mirror of the upper-arm survivor. `quality` is [1,3] with slack 0.04, and
    // -0.03 is inside it. Correct code clamps to index 0 and yields min = 1;
    // dropping `Math.max(score, 0)` yields 0.97 — below the range the question
    // declared, handed to a caller that trusts it. (-0.03 and not -0.04: `0.02*2`
    // is exact in doubles, so -0.04 sits exactly on the reject boundary.)
    respondAnswers({ quality: { type: 'score', score: -0.03 } });
    const result = await askJev({ state: {}, questions: [qualityQuestion] });
    expect((result.answers[0] as { value: number }).value).toBe(1);
  });

  it('🔴 ROUNDS to nearest — not ceil, not floor', async () => {
    // Every integer fixture in this file was 0, 1.94, 4, 4.03 or -0.05, and `ceil`
    // agrees with `round` on all five. Unpinned, `Math.ceil` is a systematic +1
    // bias on the one score the resource-intent decision is recorded against.
    // 1.2 separates them; 1.94 above already separates floor/trunc.
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: 1.2 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).resolves.toMatchObject({
      answers: [{ value: 2 }],
    });
  });

  it('refuses `integer: true` over a fractional range', async () => {
    const fractional = { ...specificityQuestion, min: 0.5, max: 4.5 };
    await expect(askJev({ state: {}, questions: [fractional] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('fractional range'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('🔴 the slack SCALES with the index arm and is not open-ended', async () => {
    // lastIndex 4 ⇒ slack 0.08. 4.5 is outside it and must still fail closed.
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: 4.5 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('(±0.08 drift)'),
    });
    // And the 2-index question's slack is smaller, so 2.1 fails there while
    // being well inside a 4-index question's. Two points, not one.
    respondAnswers({ quality: { type: 'score', score: 2.1 } });
    await expect(askJev({ state: {}, questions: [qualityQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('(±0.04 drift)'),
    });
  });

  it('🔴 rejects a NEGATIVE score beyond the slack, which rounding would otherwise hide', async () => {
    // With `integer: true`, `Math.round(-0.4)` is `-0`, so `-0 + min` lands
    // exactly on the rubric's floor: an out-of-index answer would have been
    // reported as a plausible "1 = any style works" for every prompt.
    respond({
      model: RECORDED_200.model,
      answers: { specificity: { type: 'score', score: -0.4 } },
      usage: {},
    });
    await expect(askJev({ state: {}, questions: [specificityQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('is not a number in [0,4]'),
    });
  });

  it('🔴 the PRODUCTION question spec passes the real pre-flight', async () => {
    // The seam nobody owned. `RESOURCE_INTENT_QUESTIONS` gained `criteria` +
    // `integer` specifically to satisfy the `criteria.length === max - min + 1`
    // guard — and the service suite mocks this whole module, while this suite
    // only ever exercised the guard against test-local fixtures. So the guard
    // and the spec that exists for it were tested in different universes: a
    // later `max: 10` edit without a criteria edit would throw `malformed` on
    // every production call with both suites green.
    const answers: Record<string, unknown> = {};
    for (const q of RESOURCE_INTENT_QUESTIONS) {
      if (q.type === 'noul') answers[q.id] = { type: 'noul', noul: 0.5 };
      // 🔴 A FRACTION, not 0. `score: 0` maps to `min` with or without
      // `integer: true` — `Math.round(0)` is `0` — so deleting the flag from the
      // production spec left this very test green while production started
      // returning a fraction into a `z.number().int()` consumer. The fixture for
      // a seam must not be the one value for which the property is vacuous.
      else if (q.type === 'score') answers[q.id] = { type: 'score', score: 1.94 };
      else
        answers[q.id] = {
          type: 'choice',
          choice: q.options[0],
          probabilities: { [q.options[0]]: 1 },
        };
    }
    respond({ model: RECORDED_200.model, answers, usage: RECORDED_200.usage });
    const result = await askJev({
      state: { prompt: 'p' },
      questions: RESOURCE_INTENT_QUESTIONS.map((q) => ({ ...q })),
    });
    expect(result.answers.map((a) => a.id)).toEqual(RESOURCE_INTENT_QUESTIONS.map((q) => q.id));
    // And the one score question still lands where its consumer's schema needs it.
    const specificity = result.answers.find((a) => a.id === 'specificity')!;
    // round(1.94) + min 1 = 3. Without `integer: true` it would be 2.94.
    expect(specificity).toMatchObject({ type: 'score', value: 3 });
    expect(Number.isInteger((specificity as { value: number }).value)).toBe(true);
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

  it('🔴 excludes a noul BY KIND, even if one ever arrives carrying a confidence', () => {
    // The case above cannot reach the kind check: the `JevAnswer` noul variant
    // has no `confidence` field, so the later `undefined` test skips it anyway
    // and deleting the kind check survives a mutation sweep. This cast builds
    // the state the TYPE currently forbids but an alpha vendor could start
    // sending, which is what makes the kind check reachable and the OPERATOR
    // DECISION — "the min is over non-noul answers" — actually pinned.
    const floor = jevConfidenceFloor([
      { id: 'a', type: 'noul', value: 0.28, confidence: 0.01 } as never,
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
    // 🔴 The WHOLE message, not a fragment. `ERROR_BODY_EXCERPT` is commented
    // "the vendor's message is ~130 chars … this must not clip it", and a
    // `stringContaining('is a decisions model')` is satisfied by a slice of ~45,
    // so the constant could be cut nine-fold and stay green.
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      message: expect.stringContaining(DECISIONS_MODEL_400),
    });
  });

  it('🔴 REDACTS the prompt out of a vendor body that echoes the request', async () => {
    // This endpoint answers a malformed request with a schema error describing
    // the submitted body — that is how its contract was recovered — and `state`
    // is user prompt text. The consumer writes a JevError's message straight to
    // Axiom, while the shadow row deliberately stores only sha256(prompt). An
    // echoed body would route around that into a different sink.
    const prompt = 'a very distinctive user prompt about a red sports car';
    respond(`Invalid request: expected string, received object at state.prompt ("${prompt}")`, {
      ok: false,
      status: 400,
    });
    const err = await askJev({ state: { prompt }, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject on a 400');
      },
      (e: Error) => e
    );
    expect(err.message).not.toContain(prompt);
    expect(err.message).toContain('<redacted>');
    // The diagnosis itself must survive the redaction.
    expect(err.message).toContain('state.prompt');
    expect(err.message).toContain('400');
  });

  it('🔴 redacts BEFORE the excerpt is sliced — the straddle is the dominant case', async () => {
    // The prompt cap is 6000 chars against a 400-char excerpt, and the vendor
    // answers a malformed request by echoing the submitted body. So an echoed
    // prompt almost always straddles the cut: slicing first would leak a
    // 300-plus-character prefix of user text on MOST real 400s.
    // 🔴 The fixture's geometry is the whole test, and the first attempt at it
    // SURVIVED the mutation: with 390 filler chars plus ` received "`, the prompt
    // began past char 400, so slicing first dropped it entirely and leaked
    // nothing. The prompt must BEGIN inside the 400-char excerpt and RUN PAST it.
    const prompt = `SECRETPROMPTTEXT about a red sports car ${'y'.repeat(100)}`;
    const body = `${'x'.repeat(380)}${prompt} at state.prompt`;
    expect(body.indexOf(prompt)).toBeLessThan(400);
    expect(body.indexOf(prompt) + prompt.length).toBeGreaterThan(400);
    respond(body, { ok: false, status: 400 });
    const err = await askJev({ state: { prompt }, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject on a 400');
      },
      (e: Error) => e
    );
    expect(err.message).not.toContain('SECRETPROMPT');
  });

  it('🔴 redacts EVERY state value and EVERY occurrence of each', async () => {
    // The helper's docstring says "every value"; a fixture with one value
    // appearing once observes neither half. `replace` instead of `split`/`join`
    // leaks occurrence two onwards, and iterating only the first value leaks
    // `baseModel` — which production always sends alongside `prompt`.
    const prompt = 'AAAdistinctivepromptAAA';
    const baseModel = 'BBBdistinctivemodelBBB';
    respond(`invalid: "${prompt}" and "${baseModel}" and again "${prompt}"`, {
      ok: false,
      status: 400,
    });
    const err = await askJev({ state: { prompt, baseModel }, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject on a 400');
      },
      (e: Error) => e
    );
    expect(err.message).not.toContain('AAAdistinctive');
    expect(err.message).not.toContain('BBBdistinctive');
    expect(err.message).toContain('<redacted>');
  });

  it('🔴 redacts a JSON-ESCAPED echo, which is the only form a JSON body carries', async () => {
    // The body is `await response.text()` — raw JSON bytes. A prompt containing a
    // quote or a newline never appears raw there, so a raw-only split silently
    // redacts nothing. On a free-text prompt surface that is the common case.
    const prompt = 'a "cute" cat\nwith a hat';
    const body = JSON.stringify({ error: `expected string, received ${prompt}` });
    expect(body).not.toContain(prompt); // the fixture's own premise
    respond(body, { ok: false, status: 400 });
    const err = await askJev({ state: { prompt }, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject on a 400');
      },
      (e: Error) => e
    );
    expect(err.message).not.toContain('cute');
    expect(err.message).toContain('<redacted>');
  });

  it('🔴 has NO minimum-length floor — a short prompt is still user text', async () => {
    // An earlier version of this fix had a 4-character floor, on the reasoning
    // that redacting a short value would shred the vendor's message. That trades a
    // safety cost for a diagnostic one in the wrong direction, and `prompt` is
    // `z.string().min(1)`. Both of these must go.
    respond('invalid value "abcd" and "xyz" in state', { ok: false, status: 400 });
    const err = await askJev({
      state: { prompt: 'abcd', baseModel: 'xyz' },
      questions: recordedQuestions,
    }).then(
      () => {
        throw new Error('expected askJev to reject on a 400');
      },
      (e: Error) => e
    );
    expect(err.message).not.toContain('abcd');
    expect(err.message).not.toContain('xyz');
  });

  it('rejects an absurdly long model string before it reaches any sink', async () => {
    respond({ ...RECORDED_200, model: `${AI_MODELS.JEV}-${'9'.repeat(200)}` });
    await expect(askJev({ state: {}, questions: recordedQuestions })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('over 64'),
    });
  });

  it('🔴 caps the model BEFORE the pin check, so a non-pin value cannot ride into a log', async () => {
    // The existing cap fixture starts with the pin, so the prefix check passes and
    // only the length check can fire — swapping the two blocks keeps it green. A
    // long NON-pin model separates them: with the order reversed, the whole 5000
    // characters are interpolated into the `not the pinned ...` message.
    respond({ ...RECORDED_200, model: 'z'.repeat(5000) });
    const err = await askJev({ state: {}, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject');
      },
      (e: Error) => e
    );
    expect(err.message).toContain('over 64');
    expect(err.message.length).toBeLessThan(200);
  });

  it('caps any OTHER vendor-controlled string that reaches an error message', async () => {
    respond({
      ...RECORDED_200,
      answers: { ...RECORDED_200.answers, ['q'.repeat(4000)]: { type: 'noul', noul: 1 } },
    });
    const err = await askJev({ state: {}, questions: recordedQuestions }).then(
      () => {
        throw new Error('expected askJev to reject');
      },
      (e: Error) => e
    );
    expect(err.message).toContain('unknown answer key');
    expect(err.message.length).toBeLessThan(300);
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

  it('🔴 rejects a distribution summing ABOVE 1, not only below', async () => {
    // The only rejecting fixture summed to 0.62, so `Math.abs(sum - 1) > TOL`
    // could be narrowed to `(1 - sum) > TOL` and survive — and an unnormalised
    // distribution (logits, a double-counted option) is the canonical malformed
    // shape. Every member here is individually legal.
    respondAnswers({
      role: { type: 'choice', choice: 'character', probabilities: { character: 0.75, style: 0.5 } },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('sums to 1.25'),
    });
  });

  it('🔴 pins the tolerance BOUNDARY, so it cannot be widened undetected', async () => {
    // 0.97 is 0.03 off — just outside the 0.02 tolerance. Without this the
    // constant could go to anything under 0.38 and stay green.
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        probabilities: { character: 0.5, style: 0.46875 },
      },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('sums to 0.96875'),
    });
  });

  it('🔴 rejects an argmax that is absent from its own distribution', async () => {
    // Passes every other check, and then `combineStage3Answers` (resource-intent-stage3.ts)
    // — which reads `distribution[key] ?? 0` — scores the vendor's own pick 0 for that call.
    respondAnswers({
      role: { type: 'choice', choice: 'character', probabilities: { style: 0.5, none: 0.5 } },
    });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('absent from its own distribution'),
    });
  });

  it('rejects a distribution probability ABOVE 1', async () => {
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

  it('🔴 rejects a NEGATIVE probability, which the sum check cannot see', async () => {
    // Only the upper bound was exercised, so `probability < 0` survived its
    // deletion: a negative probability would have been recorded and then
    // re-ranked on.
    //
    // 🔴 ISOLATED, which took a second attempt. The obvious fixture
    // `{character: 1.25, none: -0.25}` sums to 1.0 but trips the UPPER bound on
    // 1.25, so it kills the mutant for the wrong reason and leaves the lower
    // bound unobserved — a mutant that dies for the wrong reason proves nothing
    // about the guard. Every value here is <= 1, exactly one is negative, and the
    // sum is exactly 1.0, so the lower bound is the only check that can fire.
    respondAnswers({
      role: {
        type: 'choice',
        choice: 'character',
        probabilities: { character: 1, style: 0.25, none: -0.25 },
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

  it('rejects a confidence that is not a number', async () => {
    for (const bad of ['Infinity-ish', null]) {
      respondAnswers({ role: { ...RECORDED_200.answers.role, confidence: bad } });
      await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
        kind: 'malformed',
        message: expect.stringContaining('confidence'),
      });
    }
  });

  it('🔴 rejects a genuinely NON-FINITE confidence', async () => {
    // The case above tests non-NUMBERS — a string and a null, both of which die
    // on the `typeof` arm — so `|| !Number.isFinite(...)` survived its deletion.
    // It is reachable: `JSON.parse('{"confidence":1e400}')` yields `Infinity`,
    // and this is the only load-bearing `Number.isFinite` in the file, since the
    // score/probability/noul ones sit behind range checks that reject Infinity
    // anyway. Sent as a RAW BODY so JSON.parse does the producing.
    respond(
      '{"model":"typesafe/jev-1.13-20260917","answers":{"role":{"type":"choice","choice":"character","probabilities":{"character":1},"confidence":1e400}},"usage":{}}'
    );
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('is not a finite number'),
    });
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

  it('rejects an individual answer that is an ARRAY', async () => {
    // `typeof [] === 'object'`, so without the `Array.isArray` arm this would
    // fall through to the type cross-check and fail for the wrong reason.
    respondAnswers({ role: [] });
    await expect(askJev({ state: {}, questions: [roleQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('is not an object'),
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

  it('🔴 rejects DUPLICATE choice options', async () => {
    // The wire `criteria` is a record keyed by option, so `Object.fromEntries`
    // collapses a duplicate silently: the vendor would be offered fewer options
    // than the caller counted, and the `>=2` check would pass on a pair that is
    // really one.
    await expect(
      askJev({ state: {}, questions: [{ ...roleQuestion, options: ['a', 'b', 'a'] }] })
    ).rejects.toMatchObject({ message: expect.stringContaining('duplicate options') });
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

  it("🔴 labels a REAL fetch AbortError as a timeout, not as the network's fault", async () => {
    // Both timeout cases above reject with our own `JevError`, so the
    // `instanceof` arm always won and the `signal.aborted` branch was never
    // reached. A real `fetch` rejects with a plain `AbortError` DOMException —
    // and mislabelling that as `transport` makes the consumer write the degrade
    // reason `jev_transport`, so a timeout wave would read as a network problem
    // in the only operator-facing signal there is.
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          );
        })
    );
    const pending = askJev({ state: {}, questions: recordedQuestions });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 10);
    await assertion;
  }, 5000);

  it('honours an explicit `timeoutMs` override, not just the default', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    const pending = askJev({ state: {}, questions: recordedQuestions }, { timeoutMs: 50 });
    const assertion = expect(pending).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('50ms'),
    });
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  }, 5000);
});
