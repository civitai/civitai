/**
 * The REAL Node answer for each feed-go site-search golden fixture
 * (apps/feed-go/testdata/golden/site-search; feed-go's harness is
 * apps/feed-go/internal/server/sitesearch_golden_test.go).
 *
 * Each fixture names a request (path, JSON body, host), the session user, and the search backend's
 * answer. This file runs the real route handler (src/pages/api/search/[...path].ts) and the real
 * site-search service over it — the body schemas, the viewer, the filter clauses, the backend call,
 * the hit shaping and the passthrough all run as in production — with only what crosses the process
 * boundary answered from the fixture: the session (the handler below MixedAuthEndpoint is called with
 * the fixture's user), and, passed in as the handler's dependencies, the Flipt-backed features (the
 * host's colour: green is the SFW site), the rate limit, the profanity verdict (always clean here)
 * and the passthrough switch; plus `fetch` to the search backend.
 *
 * A served fixture's `expect.call` must equal the call this code made (path, and the JSON body as
 * parsed) and `expect.body` the exact text it wrote; a fallback fixture's `expect.nodeStatus` is the
 * status Node answers with (a fallback means Node answers it, so it must be one Node does answer). On a
 * mismatch the failure message carries `GOLDEN-ACTUAL <file> <json>`: a fixture's expectation is only
 * ever set from that output, never from Go's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { SiteSearchRouteDeps } from '~/pages/api/search/[...path]';
import type * as FeedGoShadowModule from '~/server/trpc/feed-go-shadow';

const FIXTURE_DIR = join(process.cwd(), 'apps/feed-go/testdata/golden/site-search');
const SEARCH_HOST = 'https://search.example.test';

type Fixture = {
  name: string;
  request: { path: string; body: string; host: string };
  config: { passthrough: boolean };
  viewer: {
    id: number;
    username: string;
    isModerator: boolean;
    browsingLevel: number;
    showNsfw: boolean;
  } | null;
  upstream: { status: number; body: string } | null;
  expect: {
    fallback?: string;
    nodeStatus?: number;
    call?: { path: string; body: unknown };
    body?: string;
  };
};

const state = vi.hoisted(() => ({
  fx: undefined as unknown as Fixture,
  calls: [] as { url: string; body: string }[],
  // The feed-go shadow sampler the handler is given: none (never sampled) unless a case arms one.
  shadow: undefined as FeedGoShadowModule.FeedGoShadow | undefined,
}));

type FakeReq = {
  method: string;
  url: string;
  query: { path: string[] };
  headers: Record<string, string>;
  body: unknown;
};
type FakeRes = {
  statusCode: number;
  headers: Record<string, unknown>;
  text: string | undefined;
  headersSent: boolean;
  setHeader(k: string, v: unknown): FakeRes;
  getHeader(k: string): unknown;
  getHeaders(): Record<string, unknown>;
  status(code: number): FakeRes;
  json(body: unknown): FakeRes;
  end(raw?: Buffer | string): FakeRes;
};
type RouteHandler = (req: FakeReq, res: FakeRes, user: Fixture['viewer'] | undefined) => unknown;

/** The handler's outside reads, answered from the fixture. */
const deps = {
  // No fixture is rate limited.
  checkRateLimit: async () => ({ allowed: true }),
  // The host's colour decides both features here: green is the SFW site, red the mature one (no
  // region is restricted in any fixture).
  getFeatures: ({ req }: { req: { headers: Record<string, string> } }) => {
    const green = req.headers.host?.startsWith('green.');
    return { isGreen: !!green, canViewNsfw: !green };
  },
  isProfane: async () => false,
  isPassthroughOn: () => state.fx.config.passthrough,
  shadow: {
    begin: (req: Parameters<FeedGoShadowModule.FeedGoShadow['beginSiteSearch']>[0]) =>
      state.shadow?.beginSiteSearch(req),
    capture: (...args: Parameters<FeedGoShadowModule.FeedGoShadow['captureSiteSearch']>) =>
      state.shadow?.captureSiteSearch(...args),
    finish: (...args: Parameters<FeedGoShadowModule.FeedGoShadow['finish']>) =>
      state.shadow?.finish(...args),
  },
} as unknown as SiteSearchRouteDeps;

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: unknown) => handler }));

function loadFixtures() {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      fx: JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Fixture,
    }));
}

/** The response as the handler writes it: the status and the exact text sent. */
function fakeRes() {
  const res: FakeRes = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    text: undefined as string | undefined,
    headersSent: false,
    setHeader(k: string, v: unknown) {
      res.headers[k.toLowerCase()] = v;
      return res;
    },
    getHeader: (k: string) => res.headers[k.toLowerCase()],
    getHeaders: () => res.headers,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.text = JSON.stringify(body);
      res.headersSent = true;
      return res;
    },
    end(raw?: Buffer | string) {
      res.text = raw === undefined ? '' : raw.toString();
      res.headersSent = true;
      return res;
    },
  };
  return res;
}

let handler: RouteHandler;
let shadowModule: typeof FeedGoShadowModule;

beforeAll(async () => {
  const { createSiteSearchHandler } = await import('~/pages/api/search/[...path]');
  handler = createSiteSearchHandler(deps) as unknown as RouteHandler;
  shadowModule = await import('~/server/trpc/feed-go-shadow');
}, 180_000);

beforeEach(() => {
  setEnv({ NEXT_PUBLIC_SEARCH_HOST: SEARCH_HOST, SEARCH_TOKEN_API_KEY: 'golden-key' });
  state.calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    state.calls.push({ url: String(url), body: String(init.body) });
    const up = state.fx.upstream;
    if (!up) throw new Error(`${state.fx.name}: the fixture has no backend answer`);
    return new Response(up.body, {
      status: up.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

async function run(fx: Fixture) {
  state.fx = fx;
  const path = fx.request.path.replace(/^\/api\/search\//, '').split('/');
  const req: FakeReq = {
    method: 'POST',
    url: fx.request.path,
    query: { path },
    headers: { host: fx.request.host, 'content-type': 'application/json' },
    body: JSON.parse(fx.request.body),
  };
  const res = fakeRes();
  await handler(req, res, fx.viewer ?? undefined);
  return res;
}

const fixtures = loadFixtures();

describe('feed-go site-search golden fixtures: the real Node answer', () => {
  it('finds the fixtures (a glob that matched nothing would pass every case below)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
    expect(fixtures.filter(({ fx }) => !fx.expect.fallback).length).toBeGreaterThanOrEqual(8);
  });

  it.each(fixtures.filter(({ fx }) => !fx.expect.fallback).map(({ file, fx }) => [file, fx]))(
    '%s',
    async (file, fx) => {
      const f = fx as Fixture;
      const res = await run(f);
      const call = state.calls[0]
        ? {
            path: state.calls[0].url.slice(SEARCH_HOST.length),
            body: JSON.parse(state.calls[0].body),
          }
        : null;
      const actual = { status: res.statusCode, calls: state.calls.length, call, body: res.text };
      expect(actual, `GOLDEN-ACTUAL ${file} ${JSON.stringify({ call, body: res.text })}`).toEqual({
        status: 200,
        calls: 1,
        call: f.expect.call,
        body: f.expect.body,
      });
    },
    120_000
  );

  it.each(fixtures.filter(({ fx }) => fx.expect.fallback).map(({ file, fx }) => [file, fx]))(
    '%s: Node answers it itself',
    async (file, fx) => {
      const f = fx as Fixture;
      const res = await run(f);
      expect(res.statusCode, `GOLDEN-ACTUAL ${file} status ${res.statusCode}`).toBe(
        f.expect.nodeStatus
      );
    },
    120_000
  );
});

/**
 * The route's feed-go shadow wiring (`src/pages/api/search/[...path].ts`), through the real handler
 * and the real sampler with its flag on and every request sampled: only the sampler's POST to
 * feed-go is observed instead of sent. The sampler's own unit tests
 * (src/server/trpc/__tests__/feed-go-shadow.test.ts) call capture and finish themselves, so they
 * cannot see a handler that never captures its 200 or never finishes the sample.
 */
describe('feed-go site-search: the shadow sample the route sends', () => {
  const SHADOW_BASE = 'http://feed-go.test:9090';

  function armShadow() {
    const posts: { url: string; body: string }[] = [];
    const outcomes: string[] = [];
    const queued: Array<() => void> = [];
    state.shadow = shadowModule.createFeedGoShadow({
      config: shadowModule.readFeedGoShadowConfig({
        FEED_GO_SHADOW_URL: SHADOW_BASE,
        FEED_GO_SHADOW_SAMPLE_RATE: '1',
        FEED_GO_SHADOW_MAX_PER_SECOND: '1000',
      }),
      enabled: () => false,
      enabledSiteSearch: () => true,
      random: () => 0,
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url: String(url), body: String(init.body) });
        return new Response(null, { status: 202 });
      }) as unknown as typeof fetch,
      record: (outcome) => void outcomes.push(outcome),
      recordEncode: () => undefined,
      now: () => 0,
      schedule: (fn) => void queued.push(fn),
    });
    const flush = async () => {
      while (queued.length) queued.shift()!();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    };
    return { posts, outcomes, flush };
  }

  const fixture = (file: string) => {
    const found = fixtures.find((f) => f.file === file);
    if (!found) throw new Error(`no fixture ${file}`);
    return found.fx;
  };

  afterEach(() => {
    state.shadow = undefined;
  });

  // models-signed-out-sfw-host: Node reshapes the backend's answer, so the backend's body, the call
  // and Node's answer are three different documents. tools-passthrough: Node's answer is the
  // backend's bytes.
  it.each(['models-signed-out-sfw-host.json', 'tools-passthrough.json'])(
    '%s: a 200 posts one sample with the backend call and the answer Node wrote',
    async (file) => {
      const fx = fixture(file);
      const shadow = armShadow();
      const res = await run(fx);
      await shadow.flush();
      expect(res.statusCode).toBe(200);
      expect(shadow.outcomes).toEqual(['sent']);
      expect(shadow.posts).toHaveLength(1);
      expect(shadow.posts[0].url).toBe(`${SHADOW_BASE}/internal/shadow/api/search`);
      const sent = JSON.parse(shadow.posts[0].body);
      expect(sent).toMatchObject({
        input: JSON.stringify(JSON.parse(fx.request.body)),
        path: fx.request.path,
        headers: { host: fx.request.host },
        upstream: JSON.parse(fx.upstream!.body),
        node: { upstream: fx.expect.call, body: JSON.parse(fx.expect.body!) },
      });
    },
    120_000
  );

  it('a 4xx posts nothing', async () => {
    const fx = fixture('fallback-upstream-400.json');
    const shadow = armShadow();
    const res = await run(fx);
    await shadow.flush();
    expect(res.statusCode).toBe(400);
    expect(shadow.posts).toEqual([]);
    // Finished, not abandoned: the sample is released as a non-200.
    expect(shadow.outcomes).toEqual(['skipped_status']);
  }, 120_000);
});
