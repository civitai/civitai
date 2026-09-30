import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { AI_MODELS } from '~/server/services/ai/openrouter';
import type * as OpenRouterModule from '~/server/services/ai/openrouter';

/**
 * Fail-closed contract tests for the Jev vendor seam. Every validation below is
 * a hard rule from the brief (§3 hard rules 1/2/6): unknown answer keys
 * rejected, distributions must sum to ~1 over the OFFERED options, scores/nouls
 * within their ranges, timeout → throw (the caller degrades to empty
 * suggestions), and the model pin is structural (allowFallbacks disabled so
 * OpenRouter cannot route the call elsewhere while recording our pinned id).
 */

const send = vi.fn();

vi.mock('~/server/services/ai/openrouter', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenRouterModule>();
  return {
    ...actual,
    openrouter: { chat: { send: (...args: unknown[]) => send(...args) } },
  };
});

const { askJev, buildPrompt, JevError, JEV_TIMEOUT_MS } = await import('~/server/services/ai/jev');

const choiceQuestion = {
  id: 'role',
  type: 'choice' as const,
  prompt: 'What role?',
  options: ['style', 'character', 'none'] as const,
};
const noulQuestion = {
  id: 'needsResource',
  type: 'noul' as const,
  prompt: 'Would this benefit?',
};
const scoreQuestion = {
  id: 'specificity',
  type: 'score' as const,
  prompt: 'How specific?',
  min: 1,
  max: 5,
};

function mockSendContent(content: unknown) {
  send.mockResolvedValue({
    choices: [
      { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

beforeEach(() => {
  send.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('askJev — the pinned model is structural', () => {
  it('sends the numbered JEV pin with fallbacks disabled', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1 } } },
    });
    await askJev({ state: {}, questions: [choiceQuestion] });
    const arg = send.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.model).toBe('typesafe/jev-1.13');
    expect(arg.model).toBe(AI_MODELS.JEV);
    expect(arg.provider).toEqual({ allowFallbacks: false });
    expect(arg.temperature).toBe(0);
  });

  it('never sends jev-latest', async () => {
    mockSendContent({ answers: { role: { value: 'none', distribution: { none: 1 } } } });
    await askJev({ state: {}, questions: [choiceQuestion] });
    const arg = send.mock.calls[0][0] as { model: string };
    expect(arg.model).not.toContain('latest');
  });
});

describe('askJev — happy paths', () => {
  it('parses a valid choice + score + noul set', async () => {
    mockSendContent({
      answers: {
        role: {
          value: 'style',
          distribution: { style: 0.6, character: 0.3, none: 0.1 },
          confidence: 0.9,
        },
        needsResource: { value: 0.8 },
        specificity: { value: 3 },
      },
    });
    const result = await askJev({
      state: { prompt: 'a red sports car' },
      questions: [choiceQuestion, noulQuestion, scoreQuestion],
    });
    expect(result.model).toBe(AI_MODELS.JEV);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    const role = result.answers[0];
    expect(role).toMatchObject({ id: 'role', type: 'choice', value: 'style', confidence: 0.9 });
    expect(role.type === 'choice' && role.distribution).toEqual({
      style: 0.6,
      character: 0.3,
      none: 0.1,
    });
    expect(result.answers[1]).toMatchObject({ id: 'needsResource', type: 'noul', value: 0.8 });
    expect(result.answers[2]).toMatchObject({ id: 'specificity', type: 'score', value: 3 });
  });

  it('parses JSON wrapped in markdown fences', async () => {
    send.mockResolvedValue({
      choices: [
        {
          message: {
            content:
              '```json\n{"answers":{"role":{"value":"none","distribution":{"none":1}}}}\n```',
          },
        },
      ],
      usage: {},
    });
    const result = await askJev({ state: {}, questions: [choiceQuestion] });
    expect(result.answers[0]).toMatchObject({ value: 'none' });
  });
});

describe('askJev — fail-closed validation', () => {
  it('rejects a non-JSON response', async () => {
    send.mockResolvedValue({ choices: [{ message: { content: 'I would say style, probably' } }] });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      name: 'JevError',
      kind: 'malformed',
    });
  });

  it('rejects an answer for an unknown question id', async () => {
    mockSendContent({
      answers: {
        role: { value: 'style', distribution: { style: 1 } },
        hallucinated: { value: 1 },
      },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown answer key "hallucinated"'),
    });
  });

  it('rejects a missing answer for a question', async () => {
    mockSendContent({ answers: {} });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toBeInstanceOf(
      JevError
    );
  });

  it('rejects an unknown key inside an answer object', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1 }, reasoning: 'because' } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown answer key "reasoning"'),
    });
  });

  it('rejects a value outside the offered options', async () => {
    mockSendContent({
      answers: { role: { value: 'wildcard', distribution: { wildcard: 1 } } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not one of the offered options'),
    });
  });

  it('rejects a distribution naming an option that was not offered', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 0.5, pose: 0.5 } } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown option "pose"'),
    });
  });

  it('rejects a distribution that does not sum to ~1', async () => {
    mockSendContent({
      answers: {
        role: { value: 'style', distribution: { style: 0.4, character: 0.3, none: 0.1 } },
      },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('sums to'),
    });
  });

  it('accepts a distribution within the float tolerance and keeps its values', async () => {
    mockSendContent({
      answers: {
        role: {
          value: 'style',
          // Sums to 0.999 — inside the 0.02 tolerance.
          distribution: { style: 0.6, character: 0.3, none: 0.099 },
        },
      },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).resolves.toMatchObject({
      answers: [{ value: 'style', distribution: { style: 0.6, character: 0.3, none: 0.099 } }],
    });
  });

  it('rejects a non-finite confidence', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1 }, confidence: Infinity } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('confidence'),
    });
  });

  it('rejects a NaN confidence', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1 }, confidence: NaN } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('confidence'),
    });
  });

  it('rejects a distribution probability outside [0,1]', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1.4 } } },
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('not in [0,1]'),
    });
  });

  it('rejects a score outside its rubric range', async () => {
    mockSendContent({ answers: { specificity: { value: 7 } } });
    await expect(askJev({ state: {}, questions: [scoreQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('[1,5]'),
    });
  });

  it('rejects a non-integer score', async () => {
    mockSendContent({ answers: { specificity: { value: 2.5 } } });
    await expect(askJev({ state: {}, questions: [scoreQuestion] })).rejects.toBeInstanceOf(
      JevError
    );
  });

  it('rejects a noul outside [0,1]', async () => {
    mockSendContent({ answers: { needsResource: { value: 1.5 } } });
    await expect(askJev({ state: {}, questions: [noulQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('[0,1]'),
    });
  });

  it('rejects a top-level key other than answers', async () => {
    mockSendContent({
      answers: { role: { value: 'style', distribution: { style: 1 } } },
      commentary: 'the answer is style',
    });
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'malformed',
      message: expect.stringContaining('unknown top-level key "commentary"'),
    });
  });

  it('rejects a choice with more than 255 options before sending anything', async () => {
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
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an empty question list', async () => {
    await expect(askJev({ state: {}, questions: [] })).rejects.toBeInstanceOf(JevError);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('askJev — timeout', () => {
  it('throws the timeout JevError when the vendor never answers', async () => {
    vi.useFakeTimers();
    send.mockImplementation(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late')), 10_000))
    );
    const pending = askJev({ state: {}, questions: [choiceQuestion] });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 10);
    await assertion;
  }, 5000);

  it('throws the transport JevError when the vendor errors', async () => {
    send.mockRejectedValue(new Error('502 bad gateway'));
    await expect(askJev({ state: {}, questions: [choiceQuestion] })).rejects.toMatchObject({
      kind: 'transport',
    });
  });
});

describe('🔴 the PROMPT and the PARSER describe the same envelope', () => {
  /**
   * Every other fixture in this file hand-wraps its response in `answers`, which
   * encodes the PARSER. None of them read the prompt, so none could see that an
   * earlier draft never named the wrapper: a model obeying the prompt exactly
   * returned answers at the top level and `askJev` refused it as malformed on
   * EVERY call. The endpoint would have been 100% degraded from its first real
   * request.
   *
   * ⚠️ An earlier version of this docstring added "because a degraded response is
   * byte-identical to an honest 'no resource needed', nothing would have said so".
   * RETRACTED — it is false: the two responses differ in five fields, and a degrade
   * also writes `degraded=1` to the shadow table and logs. What is true is that
   * nothing ALERTS on it. Do not re-derive the stronger claim.
   *
   * These derive the expectation from the PROMPT TEXT instead.
   */
  const questions = [noulQuestion, choiceQuestion] as const;

  it('names the `answers` envelope and forbids other top-level keys', () => {
    const { system } = buildPrompt({ state: { prompt: 'p' }, questions });
    expect(system).toContain('"answers"');
    expect(system).toMatch(/EXACTLY ONE top-level key/i);
  });

  it('🔴 the example the prompt SHOWS is accepted by the parser that reads it', async () => {
    const { system } = buildPrompt({ state: { prompt: 'p' }, questions });
    // Pull the literal JSON example out of the prompt — not a fixture we wrote.
    const example = system.split('\n').find((line) => line.trim().startsWith('{'));
    expect(example, 'the prompt must carry a concrete JSON example').toBeTruthy();
    const parsedExample = JSON.parse(example as string);

    // Re-key the example onto THIS request's ids, preserving its SHAPE — which
    // means taking the example's OWN key names for BOTH answers. An earlier
    // version of this test hand-wrote the choice answer with a literal
    // `distribution`, so renaming that key in the prompt's example (say to
    // `probabilities`) left all three tests green while production degraded on
    // every call — the exact defect this guard exists to prevent, reachable by a
    // one-word edit. Only the OPTION STRINGS are remapped; every key comes from
    // the example.
    const answers: Record<string, unknown> = {};
    const shapes = Object.values(parsedExample.answers as Record<string, unknown>);
    expect(shapes, 'the example must carry both answer shapes').toHaveLength(2);
    answers[noulQuestion.id] = shapes[0];

    const choiceShape = shapes[1] as Record<string, unknown>;
    const exampleDist = Object.entries(
      (Object.values(choiceShape).find((v) => typeof v === 'object' && v !== null) ?? {}) as Record<
        string,
        number
      >
    );
    expect(
      exampleDist.length,
      'the example choice answer must carry a distribution'
    ).toBeGreaterThan(0);
    // Rebuild using the example's own key names, with our option strings.
    const remapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(choiceShape)) {
      if (typeof v === 'object' && v !== null) {
        remapped[k] = Object.fromEntries(
          exampleDist.map(([, p], i) => [choiceQuestion.options[i] ?? 'none', p])
        );
      } else {
        remapped[k] = choiceQuestion.options[0];
      }
    }
    answers[choiceQuestion.id] = remapped;

    send.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ answers }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const res = await askJev({ state: { prompt: 'p' }, questions });
    expect(res.answers.map((a) => a.id)).toEqual([noulQuestion.id, choiceQuestion.id]);
  });

  it('🔴 an answer object at the TOP LEVEL — what the old prompt described — is refused', async () => {
    // The exact shape a compliant model produced against the pre-fix prompt.
    send.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              [noulQuestion.id]: { value: 0.8 },
              [choiceQuestion.id]: { value: 'style', distribution: { style: 1 } },
            }),
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await expect(askJev({ state: { prompt: 'p' }, questions })).rejects.toThrow(
      /unknown top-level key/
    );
  });
});
