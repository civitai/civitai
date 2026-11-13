import { describe, expect, it } from 'vitest';
import {
  buildConfirmedStepConsentCopy,
  buildConfirmedStepDailyLimitCopy,
  confirmedStepReplyFromResult,
  resolveRunConfirmedStepRequest,
  RUN_CONFIRMED_STEP_HOST_ERRORS,
  type ConfirmedStepQuotePreview,
} from '~/components/AppBlocks/runConfirmedStepGate';
import { resolveTrainingBridgePrelude } from '~/components/AppBlocks/runTrainingGate';
import { CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE } from '~/shared/constants/block-scope.constants';

/** The pure decision + copy layer of `RUN_CONFIRMED_STEP`. */

const QUOTE_ID = `sq_${'a'.repeat(32)}`;
const BODY = { kind: 'step', $type: 'polyGen', input: {}, maxBuzz: 200, quoteId: QUOTE_ID };
const OK = { ready: true, signedIn: true, reviewNack: false };

const PREVIEW: ConfirmedStepQuotePreview = {
  quoteId: QUOTE_ID,
  total: 1040,
  stepType: 'polyGen',
  expiresAt: 'x',
  shortfall: 0,
  dailyLimit: null,
  exceedsDailyLimit: false,
};

describe('resolveRunConfirmedStepRequest', () => {
  it('proceeds with the quote id and the block’s body, untouched', () => {
    expect(resolveRunConfirmedStepRequest({ raw: { requestId: 'r', body: BODY }, ...OK })).toEqual({
      kind: 'proceed',
      request: { requestId: 'r', quoteId: QUOTE_ID, body: BODY },
    });
  });

  it.each([
    ['no payload', null],
    ['no requestId', { body: BODY }],
    ['an empty requestId', { requestId: '', body: BODY }],
  ])('drops %s (nothing to reply to)', (_l, raw) => {
    expect(resolveRunConfirmedStepRequest({ raw, ...OK })).toEqual({ kind: 'drop' });
  });

  it.each([
    ['review mode', { ...OK, reviewNack: true }, 'review-mode'],
    ['a block that is not ready', { ...OK, ready: false }, 'block is not ready'],
    ['an anonymous viewer', { ...OK, signedIn: false }, 'sign in to run'],
  ])('refuses %s, in the shared prelude order', (_l, state, error) => {
    expect(
      resolveRunConfirmedStepRequest({ raw: { requestId: 'r', body: BODY }, ...state })
    ).toEqual({ kind: 'refuse', requestId: 'r', error });
  });

  it.each([
    ['no body', undefined],
    ['an array body', []],
    ['a training body', { ...BODY, kind: 'training' }],
    ['a registry step (no $type)', { kind: 'step', step: 'convert-image', quoteId: QUOTE_ID }],
    ['no quoteId', { ...BODY, quoteId: undefined }],
    ['an empty quoteId', { ...BODY, quoteId: '' }],
    ['a TRAINING quote id', { ...BODY, quoteId: `tq_${'a'.repeat(32)}` }],
    ['a malformed step quote id', { ...BODY, quoteId: 'sq_short' }],
  ])('refuses %s as invalid', (_l, body) => {
    expect(resolveRunConfirmedStepRequest({ raw: { requestId: 'r', body }, ...OK })).toEqual({
      kind: 'refuse',
      requestId: 'r',
      error: 'invalid confirmed step request',
    });
  });

  it('shares the training prelude: same order, only the sign-in code differs', () => {
    const raw = { requestId: 'r', body: BODY };
    expect(resolveTrainingBridgePrelude({ raw, ...OK, signedIn: false })).toEqual({
      kind: 'refuse',
      requestId: 'r',
      error: 'sign in to train',
    });
  });
});

describe('the host error set', () => {
  it('names the daily-limit code the server and SDK branch on', () => {
    expect(CONFIRMED_STEP_DAILY_LIMIT_ERROR_CODE).toBe('daily-limit-exceeded');
    expect(RUN_CONFIRMED_STEP_HOST_ERRORS).toContain('daily-limit-exceeded');
    expect(RUN_CONFIRMED_STEP_HOST_ERRORS).toEqual([
      'review-mode',
      'block is not ready',
      'sign in to run',
      'invalid confirmed step request',
      'no block token',
      'declined',
      'daily-limit-exceeded',
      'submission-unconfirmed',
    ]);
  });
});

describe('copy', () => {
  it('every number comes from the preview; the app name is sanitized', () => {
    const copy = buildConfirmedStepConsentCopy({
      appName: 'Mesh‮Maker',
      preview: { ...PREVIEW, shortfall: 40 },
    });
    expect(copy.priceLine).toBe('This job costs 1,040 Buzz, charged when it starts.');
    expect(copy.confirmLabel).toBe('Run for 1,040 Buzz');
    expect(copy.shortfallLine).toBe('You need 40 more Buzz to run this job.');
    expect(copy.dailyLimitLine).toBeNull();
    expect(copy.intro).not.toContain('‮');
  });

  it('shows the viewer’s limit when they set one', () => {
    const copy = buildConfirmedStepConsentCopy({
      appName: 'Mesh Maker',
      preview: { ...PREVIEW, dailyLimit: { limit: 3000, spentToday: 500, remaining: 2500 } },
    });
    expect(copy.dailyLimitLine).toBe(
      'Your daily limit for this app is 3,000 Buzz (2,500 left today).'
    );
  });

  it('the daily-limit refusal names the limit, what is left, and that nothing was charged', () => {
    expect(
      buildConfirmedStepDailyLimitCopy({
        appName: 'Mesh Maker',
        total: 1040,
        dailyLimit: { limit: 1500, spentToday: 600, remaining: 900 },
      })
    ).toEqual({
      title: 'This job exceeds your daily limit',
      body:
        'This job costs 1,040 Buzz, which exceeds your daily limit of 1,500 Buzz for Mesh Maker ' +
        '(900 left today). Nothing was charged. You can raise or remove the limit in your app settings.',
      linkLabel: 'Change your daily limit',
    });
  });
});

describe('confirmedStepReplyFromResult', () => {
  it.each([
    [
      { snapshot: { workflowId: 'w', status: 'pending' } },
      { snapshot: { workflowId: 'w', status: 'pending' } },
    ],
    [
      { snapshot: { workflowId: 'failed', status: 'failed' }, submissionUnconfirmed: true },
      { error: 'submission-unconfirmed' },
    ],
    [
      {
        snapshot: { workflowId: 'failed', status: 'failed', errorCode: 'daily-limit-exceeded' },
      },
      { error: 'daily-limit-exceeded' },
    ],
    [
      { snapshot: { workflowId: 'failed', status: 'failed', error: 'daily Buzz cap reached' } },
      { snapshot: { workflowId: 'failed', status: 'failed', error: 'daily Buzz cap reached' } },
    ],
  ])('maps %j', (result, expected) => {
    expect(confirmedStepReplyFromResult(result)).toEqual(expected);
  });

  it('an unconfirmed outcome wins over a daily-limit code on the same result', () => {
    // `submission-unconfirmed` means the job MAY be running and charged — it must never
    // be reported as "refused, nothing charged".
    expect(
      confirmedStepReplyFromResult({
        snapshot: { workflowId: 'failed', status: 'failed', errorCode: 'daily-limit-exceeded' },
        submissionUnconfirmed: true,
      })
    ).toEqual({ error: 'submission-unconfirmed' });
  });
});
