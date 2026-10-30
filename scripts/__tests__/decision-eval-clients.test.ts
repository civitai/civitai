import { inflateSync } from 'zlib';
import { describe, expect, it, vi } from 'vitest';

import {
  ControlFailedError,
  IMAGE_CONTROL,
  majorityBaseline,
  plantFlippedLabels,
  randomBaseline,
  runKnownAnswerControl,
  solidPng,
  verifyPlantedFlips,
} from '../decision-eval/controls';
import { ImajevModel, parseImajevAnswer, toImajevQuestions } from '../decision-eval/imajev-client';
import { JevArm, toJevQuestions } from '../decision-eval/jev-arm';
import { EvalSafetyError } from '../decision-eval/safety';
import { countCorrect } from '../decision-eval/scorer';
import type { DecisionQuestion, ManifestItem, Prediction } from '../decision-eval/types';

const signature: DecisionQuestion = {
  id: 'signature',
  type: 'choice',
  instructions: 'What kind of signature is on the form?',
  options: [
    { key: 'handwritten', description: 'an ink or stylus signature' },
    { key: 'typed_only', description: 'a typed name, no handwriting' },
    { key: 'none', description: 'no signature at all' },
  ],
};
const amount: DecisionQuestion = {
  id: 'amount_matches',
  type: 'noul',
  instructions: 'The screenshot shows a payment of state.ticket.claimed_amount.',
};

/** The response example from the imajev server contract (foundation #models). */
const IMAJEV_EXAMPLE = {
  model: 'imajev-4b',
  answers: {
    signature: {
      type: 'choice',
      choice: 'handwritten',
      probabilities: { handwritten: 0.95, typed_only: 0.03, none: 0.02 },
      confidence: 0.919,
      unknown_probability: 0.007,
      abstained: false,
    },
    amount_matches: { type: 'noul', noul: 0.082, unknown_probability: 0.022, abstained: false },
  },
  usage: { total_ms: 1152.9, input_tokens: 224 },
};

const launch = {
  modelName: 'imajev-4b',
  adapterSha256: 'abc',
  rotations: 4,
  calibrationSha256: 'def',
  hardware: 'RTX 3090 24GB',
};

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('ImajevModel', () => {
  it('🔴 refuses to be constructed against a host we do not control', () => {
    expect(() => new ImajevModel({ baseUrl: 'https://imajev.example.com', launch })).toThrow(
      EvalSafetyError
    );
  });

  it('posts multipart to /v1/systemone with the request JSON and image parts', async () => {
    const fetchImpl = stubFetch(IMAJEV_EXAMPLE);
    const model = new ImajevModel({ baseUrl: 'http://127.0.0.1:8765', launch, fetchImpl });
    const image = solidPng(4, 4, [1, 2, 3]);
    await model.decideWithImages({
      state: { a: 'b' },
      questions: [signature, amount],
      images: [image],
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:8765/v1/systemone');
    // A followed redirect would re-send the images to a host the allowlist never saw.
    expect(init.redirect).toBe('error');
    const form = init.body as FormData;
    expect(JSON.parse(form.get('request') as string)).toEqual({
      state: { a: 'b' },
      questions: {
        signature: {
          type: 'choice',
          instructions: signature.instructions,
          criteria: {
            handwritten: 'an ink or stylus signature',
            typed_only: 'a typed name, no handwriting',
            none: 'no signature at all',
          },
        },
        amount_matches: { type: 'noul', instructions: amount.instructions },
      },
    });
    const sent = form.getAll('image') as Blob[];
    expect(sent).toHaveLength(1);
    expect(new Uint8Array(await sent[0].arrayBuffer())).toEqual(image.bytes);
  });

  it('normalises the documented response, keeping unknown and abstained', async () => {
    const model = new ImajevModel({
      baseUrl: 'http://127.0.0.1:8765',
      launch,
      fetchImpl: stubFetch(IMAJEV_EXAMPLE),
    });
    const result = await model.decide({ state: {}, questions: [signature, amount] });
    expect(result.answers).toEqual([
      {
        id: 'signature',
        type: 'choice',
        value: 'handwritten',
        probabilities: { handwritten: 0.95, typed_only: 0.03, none: 0.02 },
        confidence: 0.919,
        unknown: 0.007,
        abstained: false,
      },
      {
        id: 'amount_matches',
        type: 'noul',
        value: 0.082,
        probabilities: { yes: 0.082, no: 0.918 },
        confidence: null,
        unknown: 0.022,
        abstained: false,
      },
    ]);
    expect(result.build).toBe(model.configId);
  });

  it('🔴 fails closed when a different model answers', async () => {
    const model = new ImajevModel({
      baseUrl: 'http://127.0.0.1:8765',
      launch,
      fetchImpl: stubFetch({ ...IMAJEV_EXAMPLE, model: 'imajev-9b' }),
    });
    await expect(model.decide({ state: {}, questions: [signature, amount] })).rejects.toThrow(
      'answered as "imajev-9b", expected "imajev-4b"'
    );
  });

  it('fails closed on an answer key nobody asked for', async () => {
    const model = new ImajevModel({
      baseUrl: 'http://127.0.0.1:8765',
      launch,
      fetchImpl: stubFetch({
        ...IMAJEV_EXAMPLE,
        answers: { ...IMAJEV_EXAMPLE.answers, extra: {} },
      }),
    });
    await expect(model.decide({ state: {}, questions: [signature, amount] })).rejects.toThrow(
      'unknown answer key "extra"'
    );
  });

  it('does not echo the error body, which can carry state', async () => {
    const model = new ImajevModel({
      baseUrl: 'http://127.0.0.1:8765',
      launch,
      fetchImpl: stubFetch({ detail: 'secret user text' }, 422),
    });
    await expect(model.decide({ state: {}, questions: [amount] })).rejects.toThrow(
      /^imajev returned HTTP 422$/
    );
  });

  it('rejects a choice outside the declared options and a distribution that does not sum to 1', () => {
    expect(() =>
      parseImajevAnswer(signature, { ...IMAJEV_EXAMPLE.answers.signature, choice: 'other' })
    ).toThrow('not one of the declared options');
    expect(() =>
      parseImajevAnswer(signature, {
        ...IMAJEV_EXAMPLE.answers.signature,
        probabilities: { handwritten: 0.5, typed_only: 0.1, none: 0.1 },
      })
    ).toThrow('sums to 0.7000');
  });

  it('puts the launch flags that change outputs into the config id', () => {
    const a = new ImajevModel({ baseUrl: 'http://127.0.0.1:1', launch });
    const b = new ImajevModel({
      baseUrl: 'http://127.0.0.1:1',
      launch: { ...launch, rotations: 1 },
    });
    expect(a.configId).not.toBe(b.configId);
  });

  it('refuses duplicate question ids', () => {
    expect(() => toImajevQuestions([amount, amount])).toThrow('duplicate question id');
  });
});

describe('JevArm', () => {
  const recorded = {
    model: 'typesafe/jev-1.13-20260917',
    answers: [
      {
        id: 'signature',
        type: 'choice' as const,
        value: 'none',
        distribution: { handwritten: 0.1, typed_only: 0.1, none: 0.8 },
        confidence: 0.7,
      },
      { id: 'amount_matches', type: 'noul' as const, value: 0.3 },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0 },
  };

  it('🔴 always asks for zero data retention', async () => {
    const ask = vi.fn().mockResolvedValue(recorded);
    const arm = new JevArm({ ask });
    await arm.decide({ state: { a: 'b' }, questions: [signature, amount] });
    expect(ask).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ zeroDataRetention: true })
    );
    expect(arm.zeroDataRetention).toBe(true);
  });

  it('sends option descriptions and reports what the vendor does not return as null', async () => {
    const ask = vi.fn().mockResolvedValue(recorded);
    const result = await new JevArm({ ask }).decide({ state: {}, questions: [signature, amount] });
    expect(ask.mock.calls[0][0].questions[0].optionDescriptions).toEqual({
      handwritten: 'an ink or stylus signature',
      typed_only: 'a typed name, no handwriting',
      none: 'no signature at all',
    });
    expect(result.answers[1]).toMatchObject({
      type: 'noul',
      confidence: null,
      unknown: null,
      abstained: null,
    });
    expect(result.build).toBe('typesafe/jev-1.13-20260917');
  });

  it('asks score questions in index space', () => {
    const [q] = toJevQuestions([
      { id: 's', type: 'score', instructions: 'i', criteria: ['lo', 'mid', 'hi'] },
    ]);
    expect(q).toMatchObject({ min: 0, max: 2, criteria: ['lo', 'mid', 'hi'] });
  });
});

describe('known-answer control', () => {
  it('builds a real PNG of the requested size and colour', () => {
    const png = solidPng(3, 2, [220, 20, 20]);
    const buf = Buffer.from(png.bytes);
    expect(buf.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(buf.readUInt32BE(16)).toBe(3);
    expect(buf.readUInt32BE(20)).toBe(2);
    const idatLength = buf.readUInt32BE(33);
    const pixels = inflateSync(buf.subarray(41, 41 + idatLength));
    expect([...pixels.subarray(0, 4)]).toEqual([0, 220, 20, 20]);
  });

  it('🔴 fails the run when the model gets the known answer wrong', async () => {
    const model = {
      configId: 'm',
      hosting: 'self-hosted' as const,
      zeroDataRetention: true,
      hostKind: 'loopback' as const,
      decide: vi.fn(),
      decideWithImages: vi.fn().mockResolvedValue({
        answers: [
          {
            id: 'colour',
            type: 'choice',
            value: 'blue',
            probabilities: null,
            confidence: null,
            unknown: null,
            abstained: null,
          },
        ],
        build: 'b',
        latencyMs: 1,
      }),
    };
    await expect(runKnownAnswerControl(model, IMAGE_CONTROL, 'moderation-image')).rejects.toThrow(
      'expected "red", got "blue"'
    );
  });

  it('🔴 a node-supplied control passes the same arm and PII gates as its items, before any call', async () => {
    const hosted = {
      configId: 'jev',
      hosting: 'third-party' as const,
      zeroDataRetention: true,
      decide: vi.fn(),
    };
    await expect(
      runKnownAnswerControl(hosted, { ...IMAGE_CONTROL, image: undefined }, 'moderation-image')
    ).rejects.toThrow('may only go to a self-hosted arm');
    await expect(
      runKnownAnswerControl(
        hosted,
        { ...IMAGE_CONTROL, image: undefined, state: { context: 'mail jane@example.com' } },
        'support-text'
      )
    ).rejects.toThrow('email-shaped');
    expect(hosted.decide).not.toHaveBeenCalled();
  });
});

describe('planted flipped labels', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
  const gold = new Map(ids.map((id, i) => [id, i % 2 ? 'x' : 'y']));
  const items: ManifestItem[] = ids.map((itemId) => ({
    itemId,
    groupKey: itemId,
    ts: '',
    split: 'dev',
    state: {},
  }));
  const perfect: Prediction[] = ids.map((itemId) => ({
    itemId,
    runKey: 'k',
    status: 'ok',
    pred: gold.get(itemId),
    confidence: 0.9,
    abstained: false,
  }));
  const counter = (g: ReadonlyMap<string, string>) =>
    countCorrect({ items, predictions: perfect, classes: ['x', 'y'] }, g);

  it('flips exactly n labels, each to a different class, reproducibly', () => {
    const a = plantFlippedLabels(gold, ['x', 'y'], 20, 7);
    expect(a.planted.size).toBe(20);
    for (const [id, f] of a.planted) {
      expect(f.flipped).not.toBe(f.original);
      expect(a.gold.get(id)).toBe(f.flipped);
    }
    expect([...plantFlippedLabels(gold, ['x', 'y'], 20, 7).planted]).toEqual([...a.planted]);
  });

  it('passes when every planted item becomes an error', () => {
    const { planted } = plantFlippedLabels(gold, ['x', 'y'], 20, 7);
    expect(verifyPlantedFlips(perfect, gold, planted, counter)).toEqual({
      expectedDelta: -20,
      observedDelta: -20,
      newErrors: 20,
      newCorrect: 0,
    });
  });

  it('🔴 catches a scorer that does not read gold', () => {
    const { planted } = plantFlippedLabels(gold, ['x', 'y'], 20, 7);
    const ignoresGold = () => perfect.length;
    expect(() => verifyPlantedFlips(perfect, gold, planted, ignoresGold)).toThrow(
      'scorer moved by 0, the flips imply -20'
    );
  });

  it('refuses to call it a pass when no planted item could become an error', () => {
    const { planted } = plantFlippedLabels(gold, ['x', 'y'], 5, 7);
    const allAbstain = perfect.map((p) => ({ ...p, pred: null, abstained: true }));
    expect(() => verifyPlantedFlips(allAbstain, gold, planted, () => 0)).toThrow(
      ControlFailedError
    );
  });
});

describe('planted flipped labels against an imperfect model', () => {
  // Three classes, so a planted item can be answered with its flipped label.
  const classes = ['x', 'y', 'z'];
  const ids = Array.from({ length: 30 }, (_, i) => `i${i}`);
  const gold = new Map(ids.map((id, i) => [id, classes[i % 3]]));
  const items: ManifestItem[] = ids.map((itemId) => ({
    itemId,
    groupKey: itemId,
    ts: '',
    split: 'dev',
    state: {},
  }));
  const { planted } = plantFlippedLabels(gold, classes, 12, 11);
  const plantedIds = [...planted.keys()];
  const [toFlipped, toAbstain, toAbstainWithPred] = plantedIds;
  const predictions: Prediction[] = ids.map((itemId) => {
    const base = { itemId, runKey: 'k', status: 'ok' as const, confidence: 0.9 };
    if (itemId === toFlipped)
      return { ...base, pred: planted.get(itemId)?.flipped, abstained: false };
    if (itemId === toAbstain) return { ...base, pred: null, abstained: true };
    // A custom mapAnswer may return a label AND abstain; both counters must skip it.
    if (itemId === toAbstainWithPred) return { ...base, pred: gold.get(itemId), abstained: true };
    return { ...base, pred: gold.get(itemId), abstained: false };
  });
  const counter = (g: ReadonlyMap<string, string>) =>
    countCorrect({ items, predictions, classes }, g);

  it('🔴 counts errors and newly correct items exactly', () => {
    expect(verifyPlantedFlips(predictions, gold, planted, counter)).toEqual({
      expectedDelta: 1 - 9,
      observedDelta: 1 - 9,
      newErrors: 9,
      newCorrect: 1,
    });
  });
});

describe('baselines', () => {
  it('majority predicts the most common prior label for every item', () => {
    const preds = majorityBaseline(
      ['a', 'b'],
      new Map([
        ['p', 'x'],
        ['q', 'x'],
        ['r', 'y'],
      ])
    );
    expect(preds.map((p) => p.pred)).toEqual(['x', 'x']);
  });

  it('random is reproducible from its seed', () => {
    expect(randomBaseline(['a', 'b', 'c'], ['x', 'y'], 3)).toEqual(
      randomBaseline(['a', 'b', 'c'], ['x', 'y'], 3)
    );
  });
});
