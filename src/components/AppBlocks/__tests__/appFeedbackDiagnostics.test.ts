import { describe, expect, it } from 'vitest';
import {
  APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS,
  clampErrorText,
  failureFromHostMessage,
  pushRecentError,
  recentErrorsAt,
  requestHintFromBlockMessage,
  withRequestHint,
} from '~/components/AppBlocks/appFeedbackDiagnostics';
import type { AppFeedbackRecentError } from '~/server/schema/app-feedback.schema';
import { appFeedbackRecentErrorSchema } from '~/server/schema/app-feedback.schema';

const AT = 1_762_000_000_000;

describe('failureFromHostMessage — which host→app replies are failures', () => {
  it('a failed workflow snapshot, keeping a real workflow id', () => {
    expect(
      failureFromHostMessage(
        'WORKFLOW_SUBMITTED',
        {
          requestId: 'r1',
          snapshot: {
            workflowId: 'wf_8412',
            status: 'failed',
            error: 'Validation failed: ecosystem: Ecosystem is currently unavailable',
            output: { images: ['SECRET_OUTPUT'] },
          },
        },
        AT
      )
    ).toStrictEqual({
      method: 'WORKFLOW_SUBMITTED',
      message: 'Validation failed: ecosystem: Ecosystem is currently unavailable',
      workflowId: 'wf_8412',
      at: AT,
      count: 1,
    });
  });

  it("drops failureSnapshot's 'failed' placeholder id — it names no workflow", () => {
    const failure = failureFromHostMessage(
      'ESTIMATE_RESULT',
      { requestId: 'r2', snapshot: { workflowId: 'failed', status: 'failed', error: 'nope' } },
      AT
    );
    expect(failure).toStrictEqual({ method: 'ESTIMATE_RESULT', message: 'nope', at: AT, count: 1 });
  });

  it('a bare error string, and an ok:false refusal with or without one', () => {
    expect(
      failureFromHostMessage('APP_STORAGE_GET_RESULT', { requestId: 'r', error: 'quota' }, AT)
        ?.message
    ).toBe('quota');
    expect(
      failureFromHostMessage('SAVE_IMAGE_RESULT', { requestId: 'r', ok: false }, AT)?.message
    ).toBe('request failed');
    expect(
      failureFromHostMessage(
        'SHARED_UPDATE_RESULT',
        { requestId: 'r', ok: false, error: 'conflict', code: 'CONFLICT' },
        AT
      )
    ).toMatchObject({ message: 'conflict', code: 'CONFLICT' });
  });

  it('an error object carries its message and code', () => {
    expect(
      failureFromHostMessage(
        'RUN_STEP_RESULT',
        { requestId: 'r', error: { code: 'BAD_REQUEST', message: 'bad step' } },
        AT
      )
    ).toMatchObject({ message: 'bad step', code: 'BAD_REQUEST' });
  });

  it('a successful reply, a push and a token refresh are not failures', () => {
    for (const [type, payload] of [
      ['WORKFLOW_SUBMITTED', { requestId: 'r', snapshot: { workflowId: 'wf', status: 'pending' } }],
      ['APP_STORAGE_GET_RESULT', { requestId: 'r', value: 'x' }],
      ['TOKEN_REFRESH_RESPONSE', { requestId: 'r', token: { token: 'T0KEN' } }],
      ['ROUTE_CHANGED', { subPath: 'a/b' }],
      ['SHARED_UPDATE_RESULT', { requestId: 'r', ok: true }],
    ] as const)
      expect(failureFromHostMessage(type, payload, AT)).toBeNull();
  });

  it('never copies anything but the error fields — not a token riding on the same reply', () => {
    const failure = failureFromHostMessage(
      'TOKEN_REFRESH_RESPONSE',
      { requestId: 'r', error: 'refresh failed', token: 'T0KEN_SENTINEL', value: 'V_SENTINEL' },
      AT
    );
    // Positive control: the failure was recorded.
    expect(failure?.message).toBe('refresh failed');
    expect(JSON.stringify(failure)).not.toMatch(/T0KEN_SENTINEL|V_SENTINEL|"r"/);
  });

  it('refuses a type that is not a bridge message type', () => {
    expect(failureFromHostMessage('<img onerror>', { error: 'x' }, AT)).toBeNull();
  });

  it('every failure it builds passes the server schema', () => {
    const failure = failureFromHostMessage('WORKFLOW_STATUS', { error: 'x'.repeat(5000) }, AT)!;
    expect(appFeedbackRecentErrorSchema.parse(failure)).toStrictEqual(failure);
  });
});

describe('clampErrorText', () => {
  it('caps at 300 characters, ellipsis included', () => {
    const out = clampErrorText('y'.repeat(301));
    expect(out).toHaveLength(300);
    expect(out.endsWith('…')).toBe(true);
    expect(clampErrorText('y'.repeat(300))).toBe('y'.repeat(300));
  });

  it('flattens control and bidi characters to spaces', () => {
    expect(clampErrorText('a\nb‮c\u0000d')).toBe('a b c d');
  });
});

const entry = (message: string, at = AT): AppFeedbackRecentError => ({
  method: 'WORKFLOW_STATUS',
  message,
  at,
  count: 1,
});

describe('pushRecentError — the ring buffer', () => {
  it('keeps the newest 10, oldest first', () => {
    let list: AppFeedbackRecentError[] = [];
    for (let i = 0; i < 13; i++) list = pushRecentError(list, entry(`e${i}`, AT + i));
    expect(list.map((e) => e.message)).toEqual([
      'e3',
      'e4',
      'e5',
      'e6',
      'e7',
      'e8',
      'e9',
      'e10',
      'e11',
      'e12',
    ]);
  });

  it('folds a repeat of the newest entry into a count, so a failing poll cannot evict the rest', () => {
    let list = pushRecentError([], entry('first'));
    for (let i = 1; i <= 25; i++) list = pushRecentError(list, entry('poll failed', AT + i));
    expect(list).toStrictEqual([entry('first'), { ...entry('poll failed', AT + 25), count: 25 }]);
  });

  it('does not fold the same text from a different request', () => {
    const a = { ...entry('nope'), input: { modelVersionId: 1 } };
    const b = { ...entry('nope'), input: { modelVersionId: 2 } };
    expect(pushRecentError([a], b)).toHaveLength(2);
  });
});

describe('recentErrorsAt — the time box', () => {
  it('keeps an entry exactly at the limit and drops one just past it', () => {
    const now = AT + APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS;
    expect(recentErrorsAt([entry('old', AT - 1), entry('edge', AT)], now)).toEqual([
      entry('edge', AT),
    ]);
  });
});

describe('requestHintFromBlockMessage — ids and enum keys from the request, nothing else', () => {
  it('a workflow body yields its kind, step and checkpoint version only', () => {
    const hint = requestHintFromBlockMessage('SUBMIT_WORKFLOW', {
      requestId: 'r',
      body: {
        kind: 'textToImage',
        step: 'convert-image',
        modelId: 55,
        modelVersionId: 812,
        params: { prompt: 'PROMPT_SENTINEL' },
        sourceImage: { url: 'https://image.example/SENTINEL' },
      },
    });
    expect(hint).toStrictEqual({
      method: 'SUBMIT_WORKFLOW',
      input: { kind: 'textToImage', step: 'convert-image', modelVersionId: 812 },
    });
  });

  it('a request with no body, or a body without those keys, gives only its type', () => {
    expect(requestHintFromBlockMessage('GET_BUZZ_BALANCE', { requestId: 'r' })).toStrictEqual({
      method: 'GET_BUZZ_BALANCE',
    });
    expect(
      requestHintFromBlockMessage('SUBMIT_WORKFLOW', {
        body: { kind: 'has spaces', modelVersionId: -3 },
      })
    ).toStrictEqual({ method: 'SUBMIT_WORKFLOW' });
  });

  it('names the failure after the request it answered', () => {
    const failure = failureFromHostMessage('WORKFLOW_SUBMITTED', { error: 'nope' }, AT)!;
    expect(
      withRequestHint(failure, { method: 'SUBMIT_WORKFLOW', input: { modelVersionId: 812 } })
    ).toStrictEqual({ ...failure, method: 'SUBMIT_WORKFLOW', input: { modelVersionId: 812 } });
    expect(withRequestHint(failure, undefined)).toBe(failure);
  });
});
