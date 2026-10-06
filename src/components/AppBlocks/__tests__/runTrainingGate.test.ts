import { describe, expect, it } from 'vitest';
import {
  buildTrainingConsentCopy,
  isTrainingSubmitTransportError,
  resolveRunTrainingRequest,
  trainingSubmitReplyFromError,
  trainingSubmitReplyFromResult,
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

describe('training submit replies', () => {
  const coded = (code: string, message = code) =>
    Object.assign(new Error(message), { data: { code } });

  it('a returned run is passed on as its snapshot', () => {
    expect(trainingSubmitReplyFromResult({ snapshot: { workflowId: '42-1' } })).toEqual({
      snapshot: { workflowId: '42-1' },
    });
  });

  it('a server answer marked unconfirmed is `submission-unconfirmed`, never its failed snapshot', () => {
    expect(
      trainingSubmitReplyFromResult({
        snapshot: { workflowId: 'failed', status: 'failed' },
        submissionUnconfirmed: true,
      })
    ).toEqual({ error: 'submission-unconfirmed' });
  });

  it('only the literal `true` marks it unconfirmed', () => {
    expect(
      trainingSubmitReplyFromResult({ snapshot: { workflowId: 'w' }, submissionUnconfirmed: 'yes' })
    ).toEqual({ snapshot: { workflowId: 'w' } });
  });

  it('a transport failure is `submission-unconfirmed` (the server may have run it)', () => {
    expect(trainingSubmitReplyFromError(new Error('Failed to fetch'))).toEqual({
      error: 'submission-unconfirmed',
    });
  });

  it('a coded server refusal is passed on as its message', () => {
    expect(trainingSubmitReplyFromError(coded('FORBIDDEN', 'not confirmed'))).toEqual({
      error: 'not confirmed',
    });
  });
});
