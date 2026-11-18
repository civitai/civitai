import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setTrpcBatchingEnabled, trpcVanilla } from '~/utils/trpc';
import {
  setFeedGoTransportEnabled,
  setFeedGoTransportModelGetAllEnabled,
} from '~/utils/trpc-go-transport';

/**
 * Client-side Go-vs-Node latency for the ported feed procedures: each request of
 * `image.getImagesAsPostsInfinite` / `model.getAll` is pushed to Faro as ONE `feed_transport`
 * measurement, tagged with the transport it ACTUALLY left on (`go` = the `/api/trpc-go` link,
 * `node` = `/api/trpc`), so real-user latency is comparable across the ramp cohort.
 *
 * Drives the real `trpcVanilla` link chain over a stubbed `fetch` (as trpc-go-transport.test.ts
 * does) and asserts on the URL requested AND the measurement pushed, so the tag is pinned to the
 * wire, not to a predicate. Every expectation is a literal.
 */

const h = vi.hoisted(() => ({
  pushMeasurement: vi.fn<(payload: unknown, options?: unknown) => void>(),
}));
vi.mock('@grafana/faro-web-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  faro: { api: { pushMeasurement: h.pushMeasurement } },
}));

type Sent = { url: string; method: string };
let sent: Sent[] = [];
/** What the stubbed fetch answers; `elapsedMs` is how far the fake clock moves while it "waits". */
let reply: { status: number; body: string; elapsedMs: number; reject?: Error } = {
  status: 200,
  body: '',
  elapsedMs: 0,
};

const OK_BODY = JSON.stringify({ result: { data: { json: { items: [], nextCursor: null } } } });
const ERROR_500_BODY = JSON.stringify({
  error: {
    json: {
      message: 'boom',
      code: -32603,
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: 'model.getAll' },
    },
  },
});

// Pairwise-distinct values that also never equal anything the assertions name, so a hardcoded
// literal in the implementation cannot pass for a measured one.
const MODEL_ID = 7_310_449;
const USERNAME = 'alice-in-feedland';
const FEED = 'image.getImagesAsPostsInfinite';
const FEED_INPUT = { modelId: MODEL_ID, modelVersionId: 2, limit: 50, username: USERNAME };
const MODELS = 'model.getAll';
const MODELS_INPUT = { sort: 'Newest', limit: 20, browsingLevel: 1, username: USERNAME };

beforeEach(() => {
  sent = [];
  reply = { status: 200, body: OK_BODY, elapsedMs: 0 };
  h.pushMeasurement.mockReset();
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  vi.useFakeTimers({ toFake: ['performance'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });
      vi.advanceTimersByTime(reply.elapsedMs);
      if (reply.reject) throw reply.reject;
      return new Response(reply.body, {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function callQuery(path: string, input: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.query(input);
  } catch {
    // Only the request and the measurement matter.
  }
}

const browser = (isAuthed: boolean) => {
  (globalThis as { window?: unknown }).window = { isAuthed };
};

const pushes = () => h.pushMeasurement.mock.calls;

describe('feed_transport measurement: transport tag follows the link the request left on', () => {
  it('model.getAll on the Go link: transport=go, duration from the clock, outcome ok', async () => {
    browser(true);
    setFeedGoTransportModelGetAllEnabled(true);
    reply.elapsedMs = 250;
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc-go/model.getAll?');
    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 250 } },
        {
          skipDedupe: true,
          context: { procedure: 'model.getAll', transport: 'go', outcome: 'ok', authed: 'true' },
        },
      ],
    ]);
  });

  it('model.getAll with its flag off: transport=node on /api/trpc (the comparison arm)', async () => {
    browser(true);
    reply.elapsedMs = 410;
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 410 } },
        {
          skipDedupe: true,
          context: { procedure: 'model.getAll', transport: 'node', outcome: 'ok', authed: 'true' },
        },
      ],
    ]);
  });

  it('the gallery on the Go link: transport=go, procedure image.getImagesAsPostsInfinite', async () => {
    browser(true);
    setFeedGoTransportEnabled(true);
    reply.elapsedMs = 133;
    await callQuery(FEED, FEED_INPUT);

    expect(sent[0].url).toContain('/api/trpc-go/image.getImagesAsPostsInfinite?');
    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 133 } },
        {
          skipDedupe: true,
          context: {
            procedure: 'image.getImagesAsPostsInfinite',
            transport: 'go',
            outcome: 'ok',
            authed: 'true',
          },
        },
      ],
    ]);
  });

  it('the gallery flag does not move model.getAll: still transport=node', async () => {
    browser(true);
    setFeedGoTransportEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1]).toMatchObject({ context: { transport: 'node' } });
  });

  it('signed out with the flag on: stays on /api/trpc, transport=node, authed=false', async () => {
    browser(false);
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1]).toEqual({
      skipDedupe: true,
      context: { procedure: 'model.getAll', transport: 'node', outcome: 'ok', authed: 'false' },
    });
  });

  it('an input too large for a GET goes as POST on /api/trpc: transport=node', async () => {
    browser(true);
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, {
      ...FEED_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });

    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain('/api/trpc-go');
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1]).toMatchObject({ context: { transport: 'node' } });
  });

  it('any other procedure is never measured (positive control: model.getAll is)', async () => {
    browser(true);
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery('model.getById', { id: MODEL_ID });
    expect(pushes()).toHaveLength(0);

    await callQuery(MODELS, MODELS_INPUT);
    expect(pushes()).toHaveLength(1);
  });
});

describe('feed_transport measurement: outcome', () => {
  it('an HTTP 500 from the Go link: outcome http_error with its status', async () => {
    browser(true);
    setFeedGoTransportModelGetAllEnabled(true);
    reply = { status: 500, body: ERROR_500_BODY, elapsedMs: 77 };
    await callQuery(MODELS, MODELS_INPUT);

    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 77 } },
        {
          skipDedupe: true,
          context: {
            procedure: 'model.getAll',
            transport: 'go',
            outcome: 'http_error',
            authed: 'true',
            status: '500',
          },
        },
      ],
    ]);
  });

  it('a non-JSON error page (a proxy 502) is an http_error, not a network error', async () => {
    browser(true);
    setFeedGoTransportEnabled(true);
    reply = { status: 502, body: '<html>Bad Gateway</html>', elapsedMs: 5 };
    await callQuery(FEED, FEED_INPUT);

    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1]).toEqual({
      skipDedupe: true,
      context: {
        procedure: 'image.getImagesAsPostsInfinite',
        transport: 'go',
        outcome: 'http_error',
        authed: 'true',
      },
    });
  });

  it('fetch rejecting (no response at all): outcome network_error on the node arm', async () => {
    browser(true);
    reply = { status: 0, body: '', elapsedMs: 9, reject: new TypeError('Failed to fetch') };
    await callQuery(MODELS, MODELS_INPUT);

    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 9 } },
        {
          skipDedupe: true,
          context: {
            procedure: 'model.getAll',
            transport: 'node',
            outcome: 'network_error',
            authed: 'true',
          },
        },
      ],
    ]);
  });
});

describe('feed_transport measurement: carries no user data', () => {
  it('nothing from the input, the URL or the user reaches the beacon', async () => {
    browser(true);
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(pushes()).toHaveLength(1);
    const beacon = JSON.stringify(pushes()[0]);
    expect(beacon).not.toContain(String(MODEL_ID));
    expect(beacon).not.toContain(USERNAME);
    expect(beacon).not.toContain('input');
    expect(beacon).not.toContain('http');
    // Exactly these context keys: a new one is a cardinality / privacy decision, not a drive-by.
    expect(Object.keys((pushes()[0][1] as { context: object }).context).sort()).toEqual([
      'authed',
      'outcome',
      'procedure',
      'transport',
    ]);
  });
});
