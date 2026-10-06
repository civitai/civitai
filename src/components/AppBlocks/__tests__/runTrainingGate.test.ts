import { describe, expect, it, vi } from 'vitest';
import {
  buildTrainingConsentCopy,
  isTrainingSubmitTransportError,
  submitTrainingWithRecovery,
  resolveRunTrainingRequest,
  type TrainingQuotePreview,
} from '~/components/AppBlocks/runTrainingGate';

const OK = { ready: true, signedIn: true, reviewNack: false };
const BODY = { kind: 'training', quoteId: 'tq_1', datasetId: 'tds_1' };

describe('resolveRunTrainingRequest', () => {
  it('drops only what has no requestId to answer', () => {
    expect(resolveRunTrainingRequest({ raw: null, ...OK })).toEqual({ kind: 'drop' });
    expect(resolveRunTrainingRequest({ raw: { body: BODY }, ...OK })).toEqual({ kind: 'drop' });
    expect(resolveRunTrainingRequest({ raw: { requestId: '', body: BODY }, ...OK })).toEqual({
      kind: 'drop',
    });
  });

  it.each([
    ['review mode', { ...OK, reviewNack: true }, BODY, 'review-mode'],
    ['a block that is not ready', { ...OK, ready: false }, BODY, 'block is not ready'],
    ['an anonymous viewer', { ...OK, signedIn: false }, BODY, 'sign in to train'],
    ['a non-training body', OK, { ...BODY, kind: 'step' }, 'invalid training request'],
    ['a body naming no quote', OK, { kind: 'training' }, 'invalid training request'],
    ['an array body', OK, [BODY], 'invalid training request'],
  ])('refuses %s with a reply', (_l, flags, body, error) => {
    expect(resolveRunTrainingRequest({ raw: { requestId: 'r1', body }, ...flags })).toEqual({
      kind: 'refuse',
      requestId: 'r1',
      error,
    });
  });

  it('proceeds with the body untouched and the quote id read off it', () => {
    expect(resolveRunTrainingRequest({ raw: { requestId: 'r1', body: BODY }, ...OK })).toEqual({
      kind: 'proceed',
      request: { requestId: 'r1', quoteId: 'tq_1', body: BODY },
    });
  });
});

describe('buildTrainingConsentCopy', () => {
  const PREVIEW: TrainingQuotePreview = {
    quoteId: 'tq_1',
    total: 1234,
    imageCount: 7,
    modelName: 'SDXL',
    epochs: 5,
    steps: 1500,
    expiresAt: 'x',
    thumbnails: [],
    shortfall: 0,
  };

  it('every number is the server preview’s', () => {
    const copy = buildTrainingConsentCopy({ appName: 'Trainer', preview: PREVIEW });
    expect(copy.priceLine).toBe('This run costs 1,234 Buzz, charged when it starts.');
    expect(copy.confirmLabel).toBe('Train for 1,234 Buzz');
    expect(copy.intro).toBe('Trainer wants to train a LoRA on 7 images from your account.');
    expect(copy.details).toEqual([
      'Base model: SDXL',
      'Length: 5 epochs, 1500 steps',
      'Dataset: 7 images',
    ]);
    expect(copy.shortfallLine).toBeNull();
  });

  it('names a shortfall only when the server reports one', () => {
    expect(
      buildTrainingConsentCopy({ preview: { ...PREVIEW, shortfall: 300 } }).shortfallLine
    ).toBe('You need 300 more Buzz to start this run.');
    expect(
      buildTrainingConsentCopy({ preview: { ...PREVIEW, shortfall: null } }).shortfallLine
    ).toBeNull();
  });

  it('sanitizes the publisher-controlled app name', () => {
    const copy = buildTrainingConsentCopy({ appName: 'Ev\u202Eil\u200B', preview: PREVIEW });
    expect(copy.intro.startsWith('Evil wants')).toBe(true);
    expect(buildTrainingConsentCopy({ appName: '\u200B', preview: PREVIEW }).intro).toMatch(
      /^This app wants/
    );
  });
});

describe('isTrainingSubmitTransportError', () => {
  it('is true only when no tRPC error code came back', () => {
    expect(isTrainingSubmitTransportError(new Error('Failed to fetch'))).toBe(true);
    expect(isTrainingSubmitTransportError(undefined)).toBe(true);
    expect(
      isTrainingSubmitTransportError(Object.assign(new Error('x'), { data: { code: 'FORBIDDEN' } }))
    ).toBe(false);
    expect(
      isTrainingSubmitTransportError(Object.assign(new Error('x'), { data: { code: 'CONFLICT' } }))
    ).toBe(false);
  });
});

describe('submitTrainingWithRecovery', () => {
  const transport = () => new Error('Failed to fetch');
  const coded = (code: string) => Object.assign(new Error(code), { data: { code } });
  const sleep = vi.fn(async () => undefined);

  it('returns the first result with no resend', async () => {
    const submit = vi.fn(async () => 'ok');
    expect(await submitTrainingWithRecovery(submit, sleep, [1, 2])).toEqual({ result: 'ok' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('a first SERVER refusal is thrown, never resent', async () => {
    const submit = vi.fn(async () => {
      throw coded('FORBIDDEN');
    });
    await expect(submitTrainingWithRecovery(submit, sleep, [1, 2])).rejects.toThrow('FORBIDDEN');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('after a transport loss, CONFLICT (first attempt still running) means wait and resend', async () => {
    const submit = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transport())
      .mockRejectedValueOnce(coded('CONFLICT'))
      .mockRejectedValueOnce(coded('CONFLICT'))
      .mockResolvedValueOnce('replayed');
    sleep.mockClear();
    expect(await submitTrainingWithRecovery(submit, sleep, [10, 20, 30, 40])).toEqual({
      result: 'replayed',
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10, 20, 30]);
  });

  it('after a transport loss, a different server error is the real outcome and is thrown', async () => {
    const submit = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transport())
      .mockRejectedValueOnce(coded('NOT_FOUND'));
    await expect(submitTrainingWithRecovery(submit, sleep, [1, 2, 3])).rejects.toThrow('NOT_FOUND');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('an outcome still unknown after every delay is UNCONFIRMED, not an error', async () => {
    const submit = vi.fn(async () => {
      throw transport();
    });
    expect(await submitTrainingWithRecovery(submit, sleep, [1, 2, 3])).toEqual({
      unconfirmed: true,
    });
    expect(submit).toHaveBeenCalledTimes(4);
  });
});
