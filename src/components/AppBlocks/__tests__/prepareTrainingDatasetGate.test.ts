import { describe, expect, it, vi } from 'vitest';
import {
  handlePrepareTrainingDataset,
  resolvePrepareTrainingDatasetRequest,
  trainingDatasetReplyFromResult,
} from '~/components/AppBlocks/prepareTrainingDatasetGate';
import {
  BLOCK_TRAINING_CAPTION_MAX_CHARS,
  BLOCK_TRAINING_DATASET_MAX_ITEMS,
} from '~/server/schema/blocks/workflow.schema';

const OK = { ready: true, signedIn: true, reviewNack: false };
const ITEMS = [
  { imageId: 11, caption: 'a red fox' },
  { imageId: 23, caption: '' },
];
const RESULT = {
  datasetId: `tds_${'c'.repeat(32)}`,
  count: 1,
  rejected: [{ imageId: 23, reason: 'unavailable' }],
};

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ imageId: i + 1, caption: '' }));

describe('resolvePrepareTrainingDatasetRequest', () => {
  it('drops only what has no requestId to answer', () => {
    expect(resolvePrepareTrainingDatasetRequest({ raw: null, ...OK })).toEqual({ kind: 'drop' });
    expect(resolvePrepareTrainingDatasetRequest({ raw: { items: ITEMS }, ...OK })).toEqual({
      kind: 'drop',
    });
    expect(
      resolvePrepareTrainingDatasetRequest({ raw: { requestId: '', items: ITEMS }, ...OK })
    ).toEqual({ kind: 'drop' });
  });

  it.each([
    ['review mode', { ...OK, reviewNack: true }, ITEMS, 'review-mode'],
    ['a block that is not ready', { ...OK, ready: false }, ITEMS, 'block is not ready'],
    ['an anonymous viewer', { ...OK, signedIn: false }, ITEMS, 'sign in to train'],
    ['missing items', OK, undefined, 'invalid training dataset'],
    ['an empty list', OK, [], 'invalid training dataset'],
    ['a non-array', OK, { imageId: 1, caption: '' }, 'invalid training dataset'],
    [
      'one item past the server ceiling',
      OK,
      items(BLOCK_TRAINING_DATASET_MAX_ITEMS + 1),
      'invalid training dataset',
    ],
    [
      'a caption one character past the server ceiling',
      OK,
      [{ imageId: 1, caption: 'x'.repeat(BLOCK_TRAINING_CAPTION_MAX_CHARS + 1) }],
      'invalid training dataset',
    ],
    ['a non-integer image id', OK, [{ imageId: 1.5, caption: '' }], 'invalid training dataset'],
    ['a non-positive image id', OK, [{ imageId: 0, caption: '' }], 'invalid training dataset'],
    ['a missing caption', OK, [{ imageId: 1 }], 'invalid training dataset'],
    [
      'an extra key on an item',
      OK,
      [{ imageId: 1, caption: '', url: 'https://x' }],
      'invalid training dataset',
    ],
  ])('refuses %s with a reply', (_l, flags, rawItems, error) => {
    expect(
      resolvePrepareTrainingDatasetRequest({ raw: { requestId: 'r1', items: rawItems }, ...flags })
    ).toEqual({ kind: 'refuse', requestId: 'r1', error });
  });

  it('accepts exactly the server ceilings (the boundary, not just the overshoot)', () => {
    const atMax = items(BLOCK_TRAINING_DATASET_MAX_ITEMS);
    atMax[0].caption = 'x'.repeat(BLOCK_TRAINING_CAPTION_MAX_CHARS);
    const out = resolvePrepareTrainingDatasetRequest({
      raw: { requestId: 'r1', items: atMax },
      ...OK,
    });
    expect(out.kind).toBe('proceed');
  });

  it('proceeds with the parsed items only — no other payload key travels', () => {
    expect(
      resolvePrepareTrainingDatasetRequest({
        raw: { requestId: 'r1', items: ITEMS, blockToken: 'smuggled' },
        ...OK,
      })
    ).toEqual({ kind: 'proceed', request: { requestId: 'r1', items: ITEMS } });
  });
});

describe('trainingDatasetReplyFromResult', () => {
  it('copies the three documented fields and nothing else', () => {
    expect(
      trainingDatasetReplyFromResult({ ...RESULT, internal: 'x' } as unknown as typeof RESULT)
    ).toEqual({ result: RESULT });
  });
});

describe('handlePrepareTrainingDataset', () => {
  function run(over: Partial<Parameters<typeof handlePrepareTrainingDataset>[0]> = {}) {
    const prepare = vi.fn().mockResolvedValue(RESULT);
    const send = vi.fn();
    const onNoToken = vi.fn();
    const done = handlePrepareTrainingDataset({
      raw: { requestId: 'rq_1', items: ITEMS },
      ...OK,
      token: 'tok_page',
      prepare,
      send,
      onNoToken,
      ...over,
    });
    return { prepare, send, onNoToken, done };
  }

  it("calls the procedure with the PAGE token and replies once with the server's result", async () => {
    const { prepare, send, done } = run();
    await done;
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith({ blockToken: 'tok_page', items: ITEMS });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('TRAINING_DATASET_RESULT', {
      requestId: 'rq_1',
      result: RESULT,
    });
  });

  it('a malformed payload is refused with an error and the procedure is never called', async () => {
    const { prepare, send, done } = run({
      raw: { requestId: 'rq_2', items: items(BLOCK_TRAINING_DATASET_MAX_ITEMS + 1) },
    });
    await done;
    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('TRAINING_DATASET_RESULT', {
      requestId: 'rq_2',
      error: 'invalid training dataset',
    });
  });

  it('no token: reports it, replies `no block token`, never calls', async () => {
    const { prepare, send, onNoToken, done } = run({ token: null });
    await done;
    expect(onNoToken).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith('TRAINING_DATASET_RESULT', {
      requestId: 'rq_1',
      error: 'no block token',
    });
  });

  it("a server refusal is passed on as the error's own message", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error('training from apps is not enabled'));
    const { send, done } = run({ prepare });
    await done;
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('TRAINING_DATASET_RESULT', {
      requestId: 'rq_1',
      error: 'training from apps is not enabled',
    });
  });

  it('a payload without a requestId gets no reply and no call', async () => {
    const { prepare, send, done } = run({ raw: { items: ITEMS } });
    await done;
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
