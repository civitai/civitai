import { instrumentationRegistry } from '@civitai/telemetry/client';
import type client from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifyTrpcCaller,
  recordTrpcCaller,
  safeClassifyTrpcCaller,
  TOOL_USER_AGENT_PREFIXES,
  TRPC_CALLER_CLASSES,
  TRPC_CALLER_SECONDS_METRIC,
  TRPC_CALLER_TOTAL_METRIC,
} from '~/server/prom/trpc-caller.metrics';

type Row = { value: number; labels: Record<string, string> };

async function rows(name: string): Promise<Row[]> {
  const metric = instrumentationRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | undefined;
  return metric ? ((await metric.get()).values as Row[]) : [];
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const USER = { id: 7 };

describe('classifyTrpcCaller', () => {
  it('pins the exported names and the five caller classes', () => {
    expect(TRPC_CALLER_TOTAL_METRIC).toBe('civitai_app_trpc_caller_total');
    expect(TRPC_CALLER_SECONDS_METRIC).toBe('civitai_app_trpc_caller_seconds_sum');
    expect([...TRPC_CALLER_CLASSES]).toEqual([
      'session',
      'api_key',
      'anon_browser',
      'anon_tool_ua',
      'internal',
    ]);
  });

  it('a signed-in session user is session', () => {
    expect(classifyTrpcCaller({ cache: {}, user: USER, userAgent: CHROME_UA })).toBe('session');
  });

  it('a banned (still signed-in) user is session', () => {
    expect(classifyTrpcCaller({ cache: {}, bannedUser: USER, userAgent: CHROME_UA })).toBe(
      'session'
    );
  });

  it('an API key wins over the user it resolves to', () => {
    expect(
      classifyTrpcCaller({ cache: {}, user: USER, apiKeyId: 12, userAgent: 'python-requests/2.31' })
    ).toBe('api_key');
  });

  it('an OAuth token (subject, no key id) is api_key', () => {
    expect(
      classifyTrpcCaller({ cache: {}, user: USER, subject: { type: 'oauth', id: 'c1' } })
    ).toBe('api_key');
  });

  it('a server-side prefetch context (cache: null) is internal, whoever the viewer is', () => {
    expect(classifyTrpcCaller({ cache: null, user: USER, apiKeyId: 3, userAgent: CHROME_UA })).toBe(
      'internal'
    );
    expect(classifyTrpcCaller({ cache: null })).toBe('internal');
  });

  it('a context without a cache field is not internal', () => {
    expect(classifyTrpcCaller({ userAgent: CHROME_UA })).toBe('anon_browser');
  });

  it('an anonymous browser is anon_browser', () => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: CHROME_UA })).toBe('anon_browser');
  });

  it.each([
    'python-requests/2.31.0',
    'Python-urllib/3.11',
    'Python/3.11 aiohttp/3.9.1',
    'curl/8.4.0',
    'Wget/1.21.4',
    'Go-http-client/1.1',
    'Go-http-client/2.0',
    'axios/1.6.2',
    'node-fetch/1.0 (+https://github.com/bitinn/node-fetch)',
    'node',
    'undici',
    'okhttp/4.12.0',
    'Java/17.0.2',
    'Apache-HttpClient/4.5.14 (Java/17.0.2)',
    'libwww-perl/6.72',
    'Scrapy/2.11.0 (+https://scrapy.org)',
    'PostmanRuntime/7.36.0',
  ])('anonymous tool user agent %j is anon_tool_ua', (ua) => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: ua })).toBe('anon_tool_ua');
  });

  it('every listed tool prefix classifies as anon_tool_ua', () => {
    for (const prefix of TOOL_USER_AGENT_PREFIXES) {
      expect(classifyTrpcCaller({ cache: {}, userAgent: `${prefix}/1.0` }), prefix).toBe(
        'anon_tool_ua'
      );
    }
  });

  it('matches a tool user agent in any case', () => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: 'CURL/8.0' })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: 'pYtHoN-ReQuEsTs/2.0' })).toBe(
      'anon_tool_ua'
    );
  });

  it('an empty, blank, missing or array user agent is classified, never thrown on', () => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: '' })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: '   ' })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: undefined })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: null })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: ['curl/8.0'] })).toBe('anon_tool_ua');
    expect(classifyTrpcCaller({ cache: {}, userAgent: [CHROME_UA] })).toBe('anon_browser');
  });

  it('a browser user agent that contains a tool token later on stays a browser', () => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: `${CHROME_UA} curl/8.0 python` })).toBe(
      'anon_browser'
    );
  });

  it('a word that only starts like a tool token is not a tool', () => {
    expect(classifyTrpcCaller({ cache: {}, userAgent: 'Javelin/1.0' })).toBe('anon_browser');
    expect(classifyTrpcCaller({ cache: {}, userAgent: 'curlew/1.0' })).toBe('anon_browser');
  });

  it('no input ever produces a value outside the five classes', () => {
    const allowed = new Set<string>(TRPC_CALLER_CLASSES);
    const inputs: unknown[] = [
      {},
      { cache: undefined },
      { cache: null },
      { userAgent: 42 },
      { userAgent: { toString: () => 'curl' } },
      { userAgent: [] },
      { apiKeyId: 0 },
      { user: 0, userAgent: 'x' },
      { userAgent: 'internal' },
      { userAgent: 'session' },
      { userAgent: '\u0000￿' },
    ];
    for (const input of inputs) {
      const out = safeClassifyTrpcCaller(input as never);
      expect(allowed.has(out), JSON.stringify(input)).toBe(true);
    }
    // A context whose getters throw cannot throw into the request path.
    const hostile = Object.defineProperty({}, 'cache', {
      get() {
        throw new Error('boom');
      },
    });
    expect(safeClassifyTrpcCaller(hostile as never)).toBe('anon_tool_ua');
  });
});

describe('recordTrpcCaller', () => {
  beforeEach(async () => {
    for (const name of [TRPC_CALLER_TOTAL_METRIC, TRPC_CALLER_SECONDS_METRIC]) {
      const metric = instrumentationRegistry.getSingleMetric(name) as client.Counter | undefined;
      await metric?.get(); // fold any pending calls in, then clear them
      metric?.reset();
    }
  });

  it('counts one call per record, labelled by path and caller', async () => {
    recordTrpcCaller('image.getInfinite', 'anon_browser', 0.25);
    recordTrpcCaller('image.getInfinite', 'anon_browser', 0.5);
    recordTrpcCaller('image.getInfinite', 'session', 0.125);
    recordTrpcCaller('model.getById', 'api_key', 2);
    const total = await rows(TRPC_CALLER_TOTAL_METRIC);
    expect(total).toHaveLength(3);
    expect(total).toEqual(
      expect.arrayContaining([
        { value: 2, labels: { path: 'image.getInfinite', caller: 'anon_browser' } },
        { value: 1, labels: { path: 'image.getInfinite', caller: 'session' } },
        { value: 1, labels: { path: 'model.getById', caller: 'api_key' } },
      ])
    );
  });

  it('adds each call duration to the seconds sum', async () => {
    recordTrpcCaller('image.getInfinite', 'anon_browser', 0.25);
    recordTrpcCaller('image.getInfinite', 'anon_browser', 0.5);
    recordTrpcCaller('model.getById', 'internal', 3.375);
    const seconds = await rows(TRPC_CALLER_SECONDS_METRIC);
    expect(seconds).toHaveLength(2);
    expect(seconds).toEqual(
      expect.arrayContaining([
        { value: 0.75, labels: { path: 'image.getInfinite', caller: 'anon_browser' } },
        { value: 3.375, labels: { path: 'model.getById', caller: 'internal' } },
      ])
    );
  });

  it('a negative or non-finite duration still counts the call and never throws', async () => {
    expect(() => recordTrpcCaller('a.b', 'session', -1)).not.toThrow();
    expect(() => recordTrpcCaller('a.b', 'session', Number.NaN)).not.toThrow();
    expect(() => recordTrpcCaller('a.b', 'session', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(await rows(TRPC_CALLER_TOTAL_METRIC)).toEqual([
      { value: 3, labels: { path: 'a.b', caller: 'session' } },
    ]);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([]);
  });

  it('a second scrape adds only the calls recorded since the first', async () => {
    recordTrpcCaller('a.b', 'anon_tool_ua', 0.5);
    expect(await rows(TRPC_CALLER_TOTAL_METRIC)).toEqual([
      { value: 1, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
    expect(await rows(TRPC_CALLER_TOTAL_METRIC)).toEqual([
      { value: 1, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
    recordTrpcCaller('a.b', 'anon_tool_ua', 0.25);
    expect(await rows(TRPC_CALLER_TOTAL_METRIC)).toEqual([
      { value: 2, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
    expect(await rows(TRPC_CALLER_SECONDS_METRIC)).toEqual([
      { value: 0.75, labels: { path: 'a.b', caller: 'anon_tool_ua' } },
    ]);
  });

  it('exports both metrics as counters with exactly the path and caller labels', async () => {
    recordTrpcCaller('a.b', 'session', 1);
    const text = await instrumentationRegistry.metrics();
    expect(text).toContain('# TYPE civitai_app_trpc_caller_total counter');
    expect(text).toContain('# TYPE civitai_app_trpc_caller_seconds_sum counter');
    expect(text).toContain('civitai_app_trpc_caller_total{path="a.b",caller="session"} 1');
    expect(text).toContain('civitai_app_trpc_caller_seconds_sum{path="a.b",caller="session"} 1');
  });
});
