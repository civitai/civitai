import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockVariant } = vi.hoisted(() => ({
  mockVariant: vi.fn<(flag: string) => Promise<string | null>>(async () => null),
}));
vi.mock('~/env/server', () => ({ env: {} }));
vi.mock('~/server/flipt/client', () => ({
  getFliptVariant: (flag: string) => mockVariant(flag),
  FLIPT_FEATURE_FLAGS: { APP_BLOCKS_REVIEW_BOOT_CHECK: 'app-blocks-review-boot-check' },
}));
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));

import {
  callBootChecker,
  decideBootCheckSettle,
  evaluateReviewBootCheck,
  firstBootError,
  readReviewBootCheckMode,
  reviewHostSandbox,
  runReviewBootCheck,
  sanitizeBootError,
  type BootCheckAttempt,
} from '~/server/services/blocks/review-boot-check.service';

const CHECKER = 'http://boot-checker.test';
const HOST = 'review-abc.civit.ai';
const URL_ = `https://${HOST}/my-app`;
const respond = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const REQ = {
  url: `${URL_}?mr=t`,
  blockId: 'my-app',
  blockInstanceId: 'page_pubreq_1',
  sandbox: 'allow-scripts',
  timeoutMs: 10000,
};
const noSignal = () => undefined;

afterEach(() => {
  mockVariant.mockReset();
  mockVariant.mockImplementation(async () => null);
});

describe('readReviewBootCheckMode', () => {
  it.each([
    ['shadow', 'shadow'],
    ['enforce', 'enforce'],
    ['off', 'off'],
    [null, 'off'],
    ['ENFORCE', 'off'],
    ['log', 'off'],
  ])('variant %s reads %s', async (variant, mode) => {
    mockVariant.mockResolvedValue(variant);
    expect(await readReviewBootCheckMode()).toBe(mode);
    expect(mockVariant).toHaveBeenCalledWith('app-blocks-review-boot-check');
  });

  it('a flag read that throws is off', async () => {
    mockVariant.mockRejectedValue(new Error('flipt down'));
    expect(await readReviewBootCheckMode()).toBe('off');
  });
});

describe('callBootChecker', () => {
  const call = (res: Response | Error) =>
    callBootChecker(REQ, {
      baseUrl: `${CHECKER}/`,
      signalFactory: noSignal,
      fetchImpl: vi.fn(async () => {
        if (res instanceof Error) throw res;
        return res;
      }) as unknown as typeof fetch,
    });

  it('passed: no firstError, the messages kept', async () => {
    expect(
      await call(respond(200, { result: 'passed', ms: 812.4, messagesSeen: ['BLOCK_READY'] }))
    ).toEqual({ result: 'passed', ms: 812, messagesSeen: ['BLOCK_READY'], firstError: null });
  });

  it('🔴 failed with no console error: the COUNT of non-JavaScript scripts (the real shape)', async () => {
    expect(
      await call(
        respond(200, {
          result: 'failed',
          ms: 10004,
          messagesSeen: [],
          consoleErrors: [],
          failedRequests: [
            { url: '/main.mjs', status: 200, contentType: 'application/octet-stream' },
          ],
          nonJsModuleResponses: 2,
          blockedScripts: [],
        })
      )
    ).toEqual({
      result: 'failed',
      ms: 10004,
      messagesSeen: [],
      firstError: '2 scripts were served as non-JavaScript',
    });
  });

  it('🔴 a 4xx is a contract refusal: unavailable, reason contract, logged at error level', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const out = await call(respond(400, { reason: 'url must be https' }));
      expect(out).toMatchObject({ result: 'unavailable', unavailableReason: 'contract' });
      expect(error).toHaveBeenCalledWith(
        '[review-boot-check] checker refused the request (400): url must be https'
      );
    } finally {
      error.mockRestore();
    }
  });

  it("a 503 is unavailable with reason server, and the checker's own reason is kept for the log", async () => {
    expect(await call(respond(503, { reason: 'inconclusive: entry answered 401' }))).toMatchObject({
      result: 'unavailable',
      unavailableReason: 'server',
      reason: 'checker answered 503: inconclusive: entry answered 401',
    });
  });

  it.each([
    ['a 503', respond(503, { error: 'x' })],
    ['a 500', respond(500, 'oops')],
    ['a 404', respond(404, {})],
    ['a 422', respond(422, {})],
    ['a non-JSON 200', respond(200, '<html>')],
    ['a 200 with no result', respond(200, { ms: 1 })],
    ['a 200 with an unknown result', respond(200, { result: 'maybe' })],
    ['a network error', new TypeError('fetch failed')],
    ['the client timeout', Object.assign(new Error('aborted'), { name: 'TimeoutError' })],
  ])('%s is unavailable', async (_label, res) => {
    expect((await call(res)).result).toBe('unavailable');
  });

  it("posts to <base>/v1/boot-check with a 35 s cap (above the checker's own 30 s)", async () => {
    const fetchImpl = vi.fn(async () => respond(200, { result: 'passed' }));
    const signalFactory = vi.fn(() => undefined);
    await callBootChecker(REQ, {
      baseUrl: CHECKER,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signalFactory,
    });
    expect(signalFactory).toHaveBeenCalledWith(35000);
    expect(fetchImpl).toHaveBeenCalledWith('http://boot-checker.test/v1/boot-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(REQ),
      signal: undefined,
    });
  });
});

describe('firstBootError / sanitizeBootError', () => {
  it('prefers the first non-empty console error over the non-JavaScript count', () => {
    expect(
      firstBootError({
        consoleErrors: ['  ', 'TypeError: x is undefined'],
        nonJsModuleResponses: 3,
      })
    ).toBe('TypeError: x is undefined');
  });

  it.each([
    [1, '1 script was served as non-JavaScript'],
    [3, '3 scripts were served as non-JavaScript'],
    [0, null],
    [-1, null],
    [1.5, null],
    ['2', null],
    [[{ url: 'a.mjs' }], null],
  ])('nonJsModuleResponses %j → %j', (n, out) => {
    expect(firstBootError({ consoleErrors: [], nonJsModuleResponses: n })).toBe(out);
  });

  it('🔴 redacts the entry token a browser error can quote', () => {
    expect(
      sanitizeBootError(`Failed to load https://${HOST}/my-app?mr=abc.def&x=1 (blocked)`)
    ).toBe(`Failed to load https://${HOST}/my-app?mr=[redacted]&x=1 (blocked)`);
  });

  it('one bounded line', () => {
    expect(sanitizeBootError('a\n\tb\u0000c')).toBe('a b c');
    const long = sanitizeBootError('x'.repeat(500));
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('reviewHostSandbox', () => {
  it.each([
    [null, 'allow-scripts'],
    ['allow-scripts allow-forms allow-popups allow-same-origin', 'allow-scripts allow-forms'],
    ['allow-downloads', 'allow-scripts'],
  ])('manifest %s → %s', (manifest, expected) => {
    expect(reviewHostSandbox(manifest)).toBe(expected);
  });
});

describe('runReviewBootCheck', () => {
  const target = async () => ({ slug: 'from-row', sandbox: 'allow-scripts allow-forms' });
  const input = { publishRequestId: 'pubreq_1', slug: 'my-app', host: HOST, url: URL_ };

  function deps(responses: Array<Response>) {
    let n = 0;
    const fetchImpl = vi.fn(async () => responses[Math.min(n++, responses.length - 1)]);
    let minted = 0;
    return {
      fetchImpl,
      deps: {
        baseUrl: CHECKER,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        signalFactory: noSignal,
        sleep: vi.fn(async () => undefined),
        mintToken: vi.fn((h: string) => `tok${++minted}-${h}`),
        loadTarget: target,
      },
    };
  }
  const bodyOf = (fetchImpl: ReturnType<typeof vi.fn>, i: number) =>
    JSON.parse(String((fetchImpl.mock.calls[i] as unknown as [string, RequestInit])[1].body));

  it('the request: the preview url + token, the slug, page_<id>, the review sandbox, 10 s', async () => {
    const { fetchImpl, deps: d } = deps([respond(200, { result: 'passed' })]);
    await runReviewBootCheck(input, d);
    expect(bodyOf(fetchImpl, 0)).toEqual({
      url: `${URL_}?mr=tok1-${HOST}`,
      blockId: 'my-app',
      blockInstanceId: 'page_pubreq_1',
      sandbox: 'allow-scripts allow-forms',
      timeoutMs: 10000,
    });
  });

  it('🔴 unavailable then passed: retried ONCE, with a freshly minted token', async () => {
    const { fetchImpl, deps: d } = deps([respond(503, {}), respond(200, { result: 'passed' })]);
    const out = await runReviewBootCheck(input, d);
    expect(out.result).toBe('passed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledWith(2000);
    expect(bodyOf(fetchImpl, 0).url).toBe(`${URL_}?mr=tok1-${HOST}`);
    expect(bodyOf(fetchImpl, 1).url).toBe(`${URL_}?mr=tok2-${HOST}`);
  });

  it('a contract refusal (4xx) is not retried: the same request would be refused again', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { fetchImpl, deps: d } = deps([respond(400, {}), respond(200, { result: 'passed' })]);
      expect((await runReviewBootCheck(input, d)).result).toBe('unavailable');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('unavailable twice: unavailable, no third attempt', async () => {
    const { fetchImpl, deps: d } = deps([respond(503, {})]);
    expect((await runReviewBootCheck(input, d)).result).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('🔴 a clean failed is never retried', async () => {
    const { fetchImpl, deps: d } = deps([
      respond(200, { result: 'failed' }),
      respond(200, { result: 'passed' }),
    ]);
    expect((await runReviewBootCheck(input, d)).result).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('no checker URL: unavailable without a call', async () => {
    const { fetchImpl, deps: d } = deps([respond(200, { result: 'passed' })]);
    expect((await runReviewBootCheck(input, { ...d, baseUrl: null })).result).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no slug on the watcher: the row slug is the block id', async () => {
    const { fetchImpl, deps: d } = deps([respond(200, { result: 'passed' })]);
    await runReviewBootCheck({ ...input, slug: undefined }, d);
    expect(bodyOf(fetchImpl, 0).blockId).toBe('from-row');
  });
});

/**
 * 🔴 THE SHADOW / ENFORCE SWITCH. Only `enforce` + `failed` fails the preview; every other cell
 * goes live with the result recorded under the mode it ran in.
 */
describe('decideBootCheckSettle', () => {
  const AT = new Date('2026-11-24T12:00:00.000Z');
  const attempt = (result: BootCheckAttempt['result']): BootCheckAttempt => ({
    result,
    ms: result === 'unavailable' ? null : 10010,
    messagesSeen: ['BLOCK_HELLO'],
    firstError: result === 'failed' ? 'SyntaxError: bad' : null,
  });

  it('enforce + failed → failed, with the author-actionable error', () => {
    expect(decideBootCheckSettle('enforce', attempt('failed'), AT)).toEqual({
      live: false,
      bootCheck: {
        result: 'failed',
        ms: 10010,
        messagesSeen: ['BLOCK_HELLO'],
        firstError: 'SyntaxError: bad',
        checkedAt: '2026-11-24T12:00:00.000Z',
        mode: 'enforce',
      },
      error:
        'Boot check: the app loaded but never sent BLOCK_READY within 10s. First error: SyntaxError: bad. Fix and resubmit.',
    });
  });

  it.each([
    ['shadow', 'failed'],
    ['shadow', 'passed'],
    ['shadow', 'unavailable'],
    ['enforce', 'passed'],
    ['enforce', 'unavailable'],
  ] as const)('%s + %s → live, recorded', (mode, result) => {
    const d = decideBootCheckSettle(mode, attempt(result), AT);
    expect(d.live).toBe(true);
    expect(d.error).toBeUndefined();
    expect(d.bootCheck.mode).toBe(mode);
    expect(d.bootCheck.result).toBe(result);
  });
});

describe('evaluateReviewBootCheck', () => {
  it('off: null, and the checker is never called', async () => {
    const fetchImpl = vi.fn();
    expect(
      await evaluateReviewBootCheck(
        { publishRequestId: 'pubreq_1', host: HOST, url: URL_ },
        { mode: 'off', baseUrl: CHECKER, fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a crash inside the check reads unavailable (fail-open), never throws', async () => {
    const d = await evaluateReviewBootCheck(
      { publishRequestId: 'pubreq_1', slug: 'my-app', host: HOST, url: URL_ },
      {
        mode: 'enforce',
        baseUrl: CHECKER,
        loadTarget: async () => {
          throw new Error('db down');
        },
      }
    );
    expect(d?.live).toBe(true);
    expect(d?.bootCheck.result).toBe('unavailable');
  });
});
