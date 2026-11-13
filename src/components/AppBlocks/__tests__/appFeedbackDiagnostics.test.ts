import { describe, expect, it } from 'vitest';
import {
  APP_FEEDBACK_RECENT_ERRORS_MAX_AGE_MS,
  browserFromUserAgent,
  buildAppFeedbackEnvironment,
  clampErrorText,
  failureFromHostMessage,
  hostRefusal,
  navigateDiagnostic,
  osFromUserAgent,
  pushRecentError,
  recentErrorsAt,
  requestHintFromBlockMessage,
  withRequestHint,
} from '~/components/AppBlocks/appFeedbackDiagnostics';
import type { AppFeedbackRecentError } from '~/server/schema/app-feedback.schema';
import {
  appFeedbackEnvironmentSchema,
  appFeedbackRecentErrorSchema,
} from '~/server/schema/app-feedback.schema';

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

  it('never cuts an emoji in half at the cap, so the stored JSON stays valid', () => {
    const out = clampErrorText(`${'a'.repeat(298)}🚫🚫`);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toBe(`${'a'.repeat(298)}…`);
    const entry = failureFromHostMessage('WORKFLOW_STATUS', { error: out }, AT)!;
    expect(appFeedbackRecentErrorSchema.safeParse(entry).success).toBe(true);
  });

  it('drops a lone surrogate already in the text', () => {
    expect(clampErrorText('bad\ud83d text')).toBe('bad text');
  });

  it('flattens control and bidi characters to spaces', () => {
    expect(clampErrorText('a\nb\u202ec\u0000d')).toBe('a b c d');
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

const UA = {
  chrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  iosSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  iosChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  samsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
};

describe('browserFromUserAgent — family and major version only', () => {
  it.each([
    ['chrome', UA.chrome, { family: 'chrome', major: 131 }],
    ['edge', UA.edge, { family: 'edge', major: 130 }],
    ['firefox', UA.firefox, { family: 'firefox', major: 132 }],
    ['safari', UA.safari, { family: 'safari', major: 17 }],
    ['iOS safari', UA.iosSafari, { family: 'safari', major: 17 }],
    ['iOS chrome', UA.iosChrome, { family: 'chrome', major: 129 }],
    ['samsung', UA.samsung, { family: 'samsung', major: 26 }],
    ['opera', UA.opera, { family: 'opera', major: 114 }],
    ['unknown', 'curl/8.4.0', { family: 'other' }],
  ])('%s', (_label, ua, expected) => {
    expect(browserFromUserAgent(ua)).toStrictEqual(expected);
  });

  it('prefers client hints, naming Edge over the Chromium brand it also carries', () => {
    expect(
      browserFromUserAgent(UA.chrome, [
        { brand: 'Chromium', version: '130' },
        { brand: 'Microsoft Edge', version: '130' },
        { brand: 'Not?A_Brand', version: '99' },
      ])
    ).toStrictEqual({ family: 'edge', major: 130 });
  });
});

describe('osFromUserAgent — OS family only', () => {
  it.each([
    ['windows', UA.chrome],
    ['linux', UA.firefox],
    ['macos', UA.safari],
    ['ios', UA.iosSafari],
    ['ios', UA.iosChrome],
    ['android', UA.samsung],
    ['chromeos', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/131.0.0.0'],
    ['other', 'curl/8.4.0'],
  ])('%s', (expected, ua) => {
    expect(osFromUserAgent(ua)).toBe(expected);
  });

  it('prefers the client-hint platform', () => {
    expect(osFromUserAgent(UA.firefox, 'Windows')).toBe('windows');
    expect(osFromUserAgent(UA.firefox, 'Plan 9')).toBe('linux');
  });
});

describe('buildAppFeedbackEnvironment', () => {
  const base = {
    userAgent: UA.firefox,
    innerWidth: 1279.6,
    innerHeight: 719.2,
    devicePixelRatio: 1.3333333,
  };

  it('rounds the window, keeps two decimals of DPR, and keeps none of the user-agent string', () => {
    const env = buildAppFeedbackEnvironment({ ...base, appRoute: '/gallery/12' });
    expect(env).toStrictEqual({
      browser: { family: 'firefox', major: 132 },
      os: 'linux',
      viewport: { width: 1280, height: 719 },
      devicePixelRatio: 1.33,
      appRoute: '/gallery/12',
    });
    expect(JSON.stringify(env)).not.toMatch(/Mozilla|Gecko|Linux/);
    expect(appFeedbackEnvironmentSchema.parse(env)).toStrictEqual(env);
  });

  it('classic scrollbars take width, overlay ones take none, unmeasured says nothing', () => {
    expect(buildAppFeedbackEnvironment({ ...base, scrollbarWidth: 17 }).scrollbars).toBe('classic');
    expect(buildAppFeedbackEnvironment({ ...base, scrollbarWidth: 0 }).scrollbars).toBe('overlay');
    expect(buildAppFeedbackEnvironment(base)).not.toHaveProperty('scrollbars');
  });

  it('caps an app route ending in an emoji without leaving half of it', () => {
    const env = buildAppFeedbackEnvironment({ ...base, appRoute: `/${'r'.repeat(198)}🚫` });
    expect(env.appRoute).toBe(`/${'r'.repeat(198)}`);
    expect(appFeedbackEnvironmentSchema.safeParse(env).success).toBe(true);
    const nav = navigateDiagnostic({ path: `/${'r'.repeat(198)}🚫` }, { scope: 'app' }, AT)!;
    expect(appFeedbackRecentErrorSchema.safeParse(nav).success).toBe(true);
  });

  it('cleans and caps the app route, and omits an empty one', () => {
    const long = buildAppFeedbackEnvironment({ ...base, appRoute: `/a\u0000b/${'x'.repeat(400)}` });
    expect(long.appRoute).toHaveLength(200);
    expect(long.appRoute!.startsWith('/ab/')).toBe(true);
    expect(buildAppFeedbackEnvironment({ ...base, appRoute: '  ' })).not.toHaveProperty('appRoute');
    expect(buildAppFeedbackEnvironment(base)).not.toHaveProperty('appRoute');
  });

  it('clamps nonsense window values into the schema instead of failing the report', () => {
    const env = buildAppFeedbackEnvironment({
      ...base,
      innerWidth: Number.NaN,
      innerHeight: 1e9,
      devicePixelRatio: 0,
    });
    expect(env.viewport).toStrictEqual({ width: 0, height: 100_000 });
    expect(env).not.toHaveProperty('devicePixelRatio');
    expect(appFeedbackEnvironmentSchema.safeParse(env).success).toBe(true);
  });
});

describe('hostRefusal — requests the host dropped or refused', () => {
  it('a host-authored message, the reason, and nothing from the request', () => {
    const entry = hostRefusal('SUBMIT_WORKFLOW', 'rate_limited', AT);
    expect(entry).toMatchObject({ method: 'SUBMIT_WORKFLOW', reason: 'rate_limited', at: AT });
    expect(entry!.message).toMatch(/^Dropped by the host/);
    expect(appFeedbackRecentErrorSchema.parse(entry)).toStrictEqual(entry);
  });

  it('records nothing for a type that is not a bridge type', () => {
    expect(hostRefusal('other', 'validator_rejected', AT)).toBeNull();
  });
});

describe('navigateDiagnostic — a NAVIGATE the host refused or rewrote', () => {
  it('a leading-slash path with no scope, resolved inside the app: rewritten, with the route', () => {
    const entry = navigateDiagnostic(
      { path: '/generate?model=1#top', target: 'current' },
      { scope: 'app' },
      AT
    );
    expect(entry).toMatchObject({
      method: 'NAVIGATE',
      reason: 'rewritten',
      scope: { requested: 'unspecified', resolved: 'app' },
      appRoute: '/generate',
    });
    expect(appFeedbackRecentErrorSchema.parse(entry)).toStrictEqual(entry);
  });

  it('a refusal records the requested scope and no path at all', () => {
    const entry = navigateDiagnostic({ path: '/admin/secret', scope: 'site' }, null, AT);
    expect(entry).toMatchObject({ reason: 'refused', scope: { requested: 'site' } });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });

  it('a navigation carried out as worded records nothing', () => {
    expect(navigateDiagnostic({ path: 'gallery', scope: 'app' }, { scope: 'app' }, AT)).toBeNull();
    expect(
      navigateDiagnostic({ path: '/models', scope: 'site' }, { scope: 'site' }, AT)
    ).toBeNull();
    expect(navigateDiagnostic({ path: 'gallery' }, { scope: 'app' }, AT)).toBeNull();
  });
});
