import { observable } from '@trpc/server/observable';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FEED_TRANSPORT_SAMPLE_RATES, feedTransportTimingLink } from '~/utils/faro/feedTransport';
import { setTrpcBatchingEnabled, trpcVanilla } from '~/utils/trpc';
import {
  GO_TRANSPORT_PROCEDURES,
  setFeedGoTransportEnabled,
  setFeedGoTransportInfiniteEnabled,
  setFeedGoTransportModelGetAllEnabled,
} from '~/utils/trpc-go-transport';

/**
 * Drives the real trpcVanilla link chain over a stubbed fetch (as trpc-go-transport.test.ts does)
 * and asserts on both the URL requested and the measurement pushed.
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
let reply: {
  status: number;
  body: string;
  elapsedMs: number;
  reject?: Error;
  /** Never answer; reject with the signal's reason once the request is aborted (as fetch does). */
  hang?: boolean;
} = {
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
const INFINITE = 'image.getInfinite';
const INFINITE_INPUT = { limit: 50, username: USERNAME };

/** The sampling draw (`Math.random`, the link's default random source) for the rest of the test. */
let randomSpy: { mockRestore: () => void } | undefined;
const drawRandom = (value: number) => {
  randomSpy?.mockRestore();
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(value);
};

beforeEach(() => {
  sent = [];
  reply = { status: 200, body: OK_BODY, elapsedMs: 0 };
  h.pushMeasurement.mockReset();
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  setFeedGoTransportInfiniteEnabled(false);
  vi.useFakeTimers({ toFake: ['performance'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });
      vi.advanceTimersByTime(reply.elapsedMs);
      if (reply.reject) throw reply.reject;
      if (reply.hang) {
        const signal = init?.signal;
        await new Promise((_, reject) => {
          if (!signal) return;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
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
  setFeedGoTransportInfiniteEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  randomSpy?.mockRestore();
  randomSpy = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function callQuery(
  path: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.query(input, signal ? { signal } : undefined);
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
          context: { procedure: 'model.getAll', transport: 'go', outcome: 'ok' },
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
          context: { procedure: 'model.getAll', transport: 'node', outcome: 'ok' },
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

  it('signed out: nothing is pushed (it can never take the Go path), even with the flag on', async () => {
    browser(false);
    setFeedGoTransportModelGetAllEnabled(true);
    await callQuery(MODELS, MODELS_INPUT);

    expect(sent[0].url).toContain('/api/trpc/model.getAll?');
    expect(pushes()).toHaveLength(0);
    // Positive control: the same request signed in IS measured (the node arm case above, and here).
    browser(true);
    await callQuery(MODELS, MODELS_INPUT);
    expect(pushes()).toHaveLength(1);
  });

  it('a POST-sized signed-in request is NOT measured (the go arm can never contain one)', async () => {
    browser(true);
    const large = { ...FEED_INPUT, excludedTagIds: Array.from({ length: 800 }, (_, i) => i) };
    await callQuery(FEED, large); // flag off: the plain node arm
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, large); // flag on: still POST on /api/trpc

    expect(sent.map((r) => r.method)).toEqual(['POST', 'POST']);
    expect(sent.every((r) => !r.url.includes('/api/trpc-go'))).toBe(true);
    expect(pushes()).toHaveLength(0);

    // Positive control: the same procedure GET-sized, flag off, is measured on the node arm.
    setFeedGoTransportEnabled(false);
    await callQuery(FEED, FEED_INPUT);
    expect(sent[2].method).toBe('GET');
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

  it('measures exactly these procedures at these rates, each a Go-transport procedure', () => {
    // Adding a procedure or raising a rate is a production change: pin the whole map.
    expect([...FEED_TRANSPORT_SAMPLE_RATES].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['image.getImagesAsPostsInfinite', 1],
      ['image.getInfinite', 0.1],
      ['model.getAll', 1],
    ]);
    for (const p of FEED_TRANSPORT_SAMPLE_RATES.keys())
      expect(GO_TRANSPORT_PROCEDURES.has(p)).toBe(true);
  });
});

/**
 * Sampling: `image.getInfinite` at 0.1, decided per request by `Math.random() < 0.1` on whichever
 * arm the request leaves on. The draws are literals chosen either side of the rate and at it.
 */
describe('feed_transport measurement: sampling', () => {
  it('image.getInfinite sampled out (draw 0.5) records nothing on EITHER arm', async () => {
    browser(true);
    drawRandom(0.5);
    await callQuery(INFINITE, INFINITE_INPUT); // flag off: node arm
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT); // flag on: go arm

    expect(sent).toHaveLength(2);
    expect(sent[0].url).toContain('/api/trpc/image.getInfinite?');
    expect(sent[1].url).toContain('/api/trpc-go/image.getInfinite?');
    expect(pushes()).toHaveLength(0);

    // Positive control: a rate-1 procedure under the same draw is measured.
    await callQuery(MODELS, MODELS_INPUT);
    expect(pushes()).toHaveLength(1);
  });

  it('image.getInfinite sampled in (draw 0.04) records on BOTH arms with sample_rate "0.1"', async () => {
    browser(true);
    drawRandom(0.04);
    reply.elapsedMs = 61;
    await callQuery(INFINITE, INFINITE_INPUT); // node arm
    setFeedGoTransportInfiniteEnabled(true);
    reply.elapsedMs = 38;
    await callQuery(INFINITE, INFINITE_INPUT); // go arm

    expect(sent[0].url).toContain('/api/trpc/image.getInfinite?');
    expect(sent[1].url).toContain('/api/trpc-go/image.getInfinite?');
    expect(pushes()).toEqual([
      [
        { type: 'feed_transport', values: { feed_transport_ms: 61 } },
        {
          skipDedupe: true,
          context: {
            procedure: 'image.getInfinite',
            transport: 'node',
            outcome: 'ok',
            sample_rate: '0.1',
          },
        },
      ],
      [
        { type: 'feed_transport', values: { feed_transport_ms: 38 } },
        {
          skipDedupe: true,
          context: {
            procedure: 'image.getInfinite',
            transport: 'go',
            outcome: 'ok',
            sample_rate: '0.1',
          },
        },
      ],
    ]);
  });

  it('boundary: a draw exactly AT the rate (0.1) is sampled out; just below (0.0999) is in', async () => {
    // `random() < rate` over [0, 1) gives a chance of exactly `rate`; `<=` would add the draw at
    // the rate itself. Both arms.
    browser(true);
    drawRandom(0.1);
    await callQuery(INFINITE, INFINITE_INPUT);
    setFeedGoTransportInfiniteEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    expect(sent).toHaveLength(2);
    expect(pushes()).toHaveLength(0);

    drawRandom(0.0999);
    await callQuery(INFINITE, INFINITE_INPUT); // go arm
    setFeedGoTransportInfiniteEnabled(false);
    await callQuery(INFINITE, INFINITE_INPUT); // node arm
    expect(pushes().map(([, o]) => (o as { context: Record<string, string> }).context)).toEqual([
      { procedure: 'image.getInfinite', transport: 'go', outcome: 'ok', sample_rate: '0.1' },
      { procedure: 'image.getInfinite', transport: 'node', outcome: 'ok', sample_rate: '0.1' },
    ]);
  });

  it('rate-1 procedures record EVERY request whatever the draw (0.999), with no sample_rate', async () => {
    browser(true);
    drawRandom(0.999);
    await callQuery(MODELS, MODELS_INPUT); // node
    await callQuery(FEED, FEED_INPUT); // node
    setFeedGoTransportModelGetAllEnabled(true);
    setFeedGoTransportEnabled(true);
    await callQuery(MODELS, MODELS_INPUT); // go
    await callQuery(FEED, FEED_INPUT); // go

    expect(sent.map((r) => r.url.split('?')[0])).toEqual([
      '/api/trpc/model.getAll',
      '/api/trpc/image.getImagesAsPostsInfinite',
      '/api/trpc-go/model.getAll',
      '/api/trpc-go/image.getImagesAsPostsInfinite',
    ]);
    expect(pushes().map(([, o]) => (o as { context: Record<string, string> }).context)).toEqual([
      { procedure: 'model.getAll', transport: 'node', outcome: 'ok' },
      { procedure: 'image.getImagesAsPostsInfinite', transport: 'node', outcome: 'ok' },
      { procedure: 'model.getAll', transport: 'go', outcome: 'ok' },
      { procedure: 'image.getImagesAsPostsInfinite', transport: 'go', outcome: 'ok' },
    ]);
  });

  it('the injected random source is drawn per request (0.07 in, 0.93 out, 0.02 in)', async () => {
    (globalThis as { window?: unknown }).window = {};
    const draws = [0.07, 0.93, 0.02];
    const push = vi.fn();
    let clock = 0;
    const link = feedTransportTimingLink({
      transport: 'go',
      isAuthed: () => true,
      random: () => draws.shift() ?? 0.5,
      now: () => (clock += 5),
      pushMeasurement: push,
    })({} as never);
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        link({
          op: { type: 'query', path: INFINITE, input: {}, id: i, context: {}, signal: null },
          next: () =>
            observable((o) => {
              o.next({ result: { data: null } } as never);
              o.complete();
            }),
        } as never).subscribe({ complete: () => resolve(), error: () => resolve() });
      });
    }
    expect(draws).toEqual([]);
    expect(push).toHaveBeenCalledTimes(2);
    expect(push.mock.calls.map(([, o]) => o.context.sample_rate)).toEqual(['0.1', '0.1']);
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
          },
        },
      ],
    ]);
  });

  it('a query aborted while its fetch is pending is NOT recorded (the cancel is no latency)', async () => {
    browser(true);
    setFeedGoTransportModelGetAllEnabled(true);
    reply = { status: 0, body: '', elapsedMs: 31, hang: true };
    const ac = new AbortController();
    const pending = callQuery(MODELS, MODELS_INPUT, ac.signal);
    // Abort only once the request is on the wire (tRPC resolves headers before calling fetch).
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    ac.abort();
    await pending;

    expect(sent[0].url).toContain('/api/trpc-go/model.getAll?');
    expect(pushes()).toHaveLength(0);
  });
});

describe('feed_transport measurement: never on the request path', () => {
  it('a throwing Faro push still resolves the query with its data', async () => {
    // Invariant guard: passes on pre-change code too (no push existed); red only on a mutant.
    browser(true);
    setFeedGoTransportModelGetAllEnabled(true);
    h.pushMeasurement.mockImplementation(() => {
      throw new Error('faro transport exploded');
    });

    await expect(trpcVanilla.model.getAll.query(MODELS_INPUT as never)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(h.pushMeasurement).toHaveBeenCalledTimes(1);
  });

  it('the node arm is unbatched in the batch cohort, so both arms time one request each', async () => {
    // Invariant guard (holds on the pre-change code too): both ported procedures are in
    // NEVER_BATCH_PROCEDURES, so a node-arm timing never includes a batch window or siblings.
    browser(true);
    setTrpcBatchingEnabled(true);
    await Promise.all([
      callQuery(MODELS, MODELS_INPUT),
      callQuery('model.getById', { id: MODEL_ID }),
    ]);

    const models = sent.filter((r) => r.url.includes('model.getAll'));
    expect(models).toHaveLength(1);
    expect(models[0].url).toContain('/api/trpc/model.getAll?');
    expect(models[0].url).not.toContain('batch=1');
    expect(models[0].url).not.toContain(',');
    // Positive control: batching IS on for this client (the sibling went out batched).
    expect(sent.some((r) => r.url.includes('model.getById') && r.url.includes('batch=1'))).toBe(
      true
    );
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0][1]).toMatchObject({
      context: { procedure: 'model.getAll', transport: 'node' },
    });
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
      'outcome',
      'procedure',
      'transport',
    ]);
  });
});
