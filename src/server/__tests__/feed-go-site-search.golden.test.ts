/**
 * The REAL Node answer for each feed-go site-search golden fixture
 * (apps/feed-go/testdata/golden/site-search; feed-go's harness is
 * apps/feed-go/internal/server/sitesearch_golden_test.go).
 *
 * Each fixture names a request (path, JSON body, host), the session user, and the search backend's
 * answer. This file runs the real route handler (src/pages/api/search/[...path].ts) and the real
 * site-search service over it — the body schemas, the viewer, the filter clauses, the backend call,
 * the hit shaping and the passthrough all run as in production — with only what crosses the process
 * boundary answered from the fixture: the session (MixedAuthEndpoint hands the fixture's user to the
 * handler), the Flipt-backed features (the host's colour: green is the SFW site), the rate limit, the
 * profanity verdict (always clean here), the passthrough switch, and `fetch` to the search backend.
 *
 * A served fixture's `expect.call` must equal the call this code made (path, and the JSON body as
 * parsed) and `expect.body` the exact text it wrote; a fallback fixture's `expect.nodeStatus` is the
 * status Node answers with (a fallback means Node answers it, so it must be one Node does answer). On a
 * mismatch the failure message carries `GOLDEN-ACTUAL <file> <json>`: a fixture's expectation is only
 * ever set from that output, never from Go's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as Profanity from '~/server/services/profanity-list.service';
import { setEnv } from '~/__tests__/mocks/env.mock';

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

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof EndpointHelpers>();
  return {
    ...actual,
    // The session crosses the boundary (the auth hub): the fixture's user, or signed out.
    MixedAuthEndpoint: (handler: RouteHandler, methods: string[] = ['GET']) => {
      return async (req: FakeReq, res: FakeRes) => {
        if (!methods.includes(req.method))
          return res.status(405).json({ error: 'Method not allowed' });
        return handler(req, res, state.fx.viewer ?? undefined);
      };
    },
  };
});
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The host's colour decides both features here: green is the SFW site, red the mature one (no
  // region is restricted in any fixture).
  getFeatureFlagsLazy: ({ req }: { req: { headers: Record<string, string> } }) => {
    const green = req.headers.host?.startsWith('green.');
    return { isGreen: !!green, canViewNsfw: !green };
  },
}));
vi.mock('~/server/utils/site-search-rate-limit', () => ({
  checkSiteSearchRateLimit: async () => ({ allowed: true }),
}));
vi.mock('~/server/services/profanity-list.service', async (importOriginal) => ({
  ...(await importOriginal<typeof Profanity>()),
  isProfaneSearch: async () => false,
}));
vi.mock('~/server/services/site-search-passthrough', () => ({
  isSiteSearchPassthroughOn: () => state.fx.config.passthrough,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: () => undefined }));
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

let handler: (req: FakeReq, res: FakeRes) => Promise<unknown>;

beforeAll(async () => {
  handler = (await import('~/pages/api/search/[...path]')).default as unknown as typeof handler;
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
  await handler(req, res);
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
