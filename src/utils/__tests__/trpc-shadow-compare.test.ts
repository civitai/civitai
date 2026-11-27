import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createShadowCompareFetch,
  type ShadowCandidate,
  type ShadowLegResponse,
} from '~/utils/faro/shadowCompare';
import { NEVER_BATCH_PROCEDURES, setTrpcBatchingEnabled, trpcVanilla } from '~/utils/trpc';
import {
  GO_TRANSPORT_PROCEDURES,
  setFeedGoTransportEnabled,
  setFeedGoTransportInfiniteEnabled,
  setFeedGoTransportModelGetAllEnabled,
  setFeedGoTransportSignedOutEnabled,
  setFeedGoTransportSignedOutInfiniteEnabled,
  setFeedGoTransportSignedOutModelGetAllEnabled,
} from '~/utils/trpc-go-transport';
import {
  SHADOW_COMPARE_PROCEDURES,
  resetShadowCompareSession,
  setClientShadowCompareEnabled,
  setClientShadowCompareSignedOutEnabled,
} from '~/utils/trpc-shadow-compare';

/**
 * Drives the real `trpcVanilla` link chain over a stubbed `fetch` (as trpc-go-transport.test.ts
 * does) and asserts on the requests sent, what the caller got back, and the `shadow_compare`
 * measurements pushed to Faro. Every expected value is a literal.
 */

const h = vi.hoisted(() => ({
  pushMeasurement: vi.fn<(payload: unknown, options?: unknown) => void>(),
}));
vi.mock('@grafana/faro-web-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  faro: { api: { pushMeasurement: h.pushMeasurement } },
}));

type Leg = 'node' | 'go';
type Reply = {
  status: number;
  body: string;
  reject?: Error;
  /** Never answer; reject once the request's signal aborts (as fetch does). */
  hang?: boolean;
  /** Answer only once this resolves. */
  gate?: Promise<void>;
  /** The Go path's `x-feed-go-served`: `go` unless set; `null` sends none. */
  servedBy?: string | null;
  /** The edge cache's verdict header (`cf-cache-status`) on this leg; none unless set. */
  cache?: string;
};
type Sent = {
  leg: Leg;
  url: string;
  method: string;
  headers: Record<string, string>;
  signal?: AbortSignal | null;
};

let sent: Sent[] = [];
let replies: Record<Leg, Reply>;
let fetchMock: ReturnType<typeof vi.fn>;

const INFINITE = 'image.getInfinite';
const INFINITE_INPUT = { limit: 50, browsingLevel: 1, period: 'Week' };
const MODELS = 'model.getAll';
const MODELS_INPUT = { sort: 'Newest', limit: 20, browsingLevel: 1 };

// 120 UTF-16 units, 122 bytes: a byte count taken from `.length` cannot pass for the real one.
const CONTROL_BODY =
  '{"result":{"data":{"json":{"items":[{"id":4101,"title":"Café crème"},{"id":4102,"title":"Dune"}],"nextCursor":"n-88"}}}}';
// Differs from CONTROL_BODY at items[1].id only; 123 bytes.
const CANDIDATE_BODY =
  '{"result":{"data":{"json":{"items":[{"id":4101,"title":"Café crème"},{"id":41020,"title":"Dune"}],"nextCursor":"n-88"}}}}';
// The same JSON value as CONTROL_BODY with two keys swapped: parse-equal, byte-different.
const REORDERED_BODY =
  '{"result":{"data":{"json":{"nextCursor":"n-88","items":[{"id":4101,"title":"Café crème"},{"id":4102,"title":"Dune"}]}}}}';
const CONTROL_DATA = {
  items: [
    { id: 4101, title: 'Café crème' },
    { id: 4102, title: 'Dune' },
  ],
  nextCursor: 'n-88',
};
const ERROR_500_BODY = JSON.stringify({
  error: {
    json: {
      message: 'boom',
      code: -32603,
      data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, path: INFINITE },
    },
  },
});

/** The signed-out cohort's three transport flags and its shadow flag, together. */
function signedOutShadow(enabled: boolean) {
  setFeedGoTransportSignedOutEnabled(enabled);
  setFeedGoTransportSignedOutModelGetAllEnabled(enabled);
  setFeedGoTransportSignedOutInfiniteEnabled(enabled);
  setClientShadowCompareSignedOutEnabled(enabled);
}

const gate = () => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
};
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  sent = [];
  replies = {
    node: { status: 200, body: CONTROL_BODY },
    go: { status: 200, body: CONTROL_BODY },
  };
  h.pushMeasurement.mockReset();
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  setFeedGoTransportInfiniteEnabled(false);
  setClientShadowCompareEnabled(false);
  signedOutShadow(false);
  resetShadowCompareSession();
  vi.useFakeTimers({ toFake: ['performance'] });
  fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    const leg: Leg = href.includes('/api/trpc-go/') ? 'go' : 'node';
    const signal = init?.signal;
    sent.push({
      leg,
      url: href,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      signal,
    });
    const reply = replies[leg];
    if (reply.gate) await reply.gate;
    if (reply.reject) throw reply.reject;
    if (reply.hang) {
      await new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (leg === 'go' && reply.servedBy !== null)
      headers['x-feed-go-served'] = reply.servedBy ?? 'go';
    if (reply.cache) headers['cf-cache-status'] = reply.cache;
    return new Response(reply.body, { status: reply.status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  setFeedGoTransportModelGetAllEnabled(false);
  setFeedGoTransportInfiniteEnabled(false);
  setClientShadowCompareEnabled(false);
  signedOutShadow(false);
  resetShadowCompareSession();
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Outcome = { data?: unknown; error?: unknown };

async function callQuery(
  path: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Outcome> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    return { data: await node.query(input, signal ? { signal } : undefined) };
  } catch (error) {
    return { error };
  }
}

async function callMutation(path: string, input: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.mutate(input);
  } catch {
    // Only the requests matter.
  }
}

const browser = (isAuthed: boolean) => {
  (globalThis as { window?: unknown }).window = { isAuthed };
};
const allTransport = (enabled: boolean) => {
  setFeedGoTransportEnabled(enabled);
  setFeedGoTransportModelGetAllEnabled(enabled);
  setFeedGoTransportInfiniteEnabled(enabled);
};
/** Signed in, shadow on, and every procedure's own Go-transport flag on (shadow needs both). */
const shadowOn = () => {
  browser(true);
  allTransport(true);
  setClientShadowCompareEnabled(true);
};
const nodeRequests = () => sent.filter((s) => s.leg === 'node');

type Push = [
  { type: string; values: Record<string, number> },
  { skipDedupe: boolean; context: Record<string, string> }
];
const shadowPushes = () =>
  (h.pushMeasurement.mock.calls as unknown as Push[]).filter(
    ([payload]) => payload.type === 'shadow_compare'
  );
const goRequests = () => sent.filter((s) => s.leg === 'go');

/** Lets any candidate request that was going to start, start. */
const settleAll = async () => {
  await macrotask();
  await macrotask();
};

describe('the allowlist', () => {
  it('is exactly these three procedures', () => {
    expect([...SHADOW_COMPARE_PROCEDURES].sort()).toEqual([
      'image.getImagesAsPostsInfinite',
      'image.getInfinite',
      'model.getAll',
    ]);
  });

  it('every shadowed procedure is never batched, so the control leg is the request the app sends', () => {
    for (const path of SHADOW_COMPARE_PROCEDURES)
      expect(NEVER_BATCH_PROCEDURES.has(path)).toBe(true);
  });

  it('every shadowed procedure has a Go-transport route, or the candidate would never run', () => {
    for (const path of SHADOW_COMPARE_PROCEDURES)
      expect(GO_TRANSPORT_PROCEDURES.has(path)).toBe(true);
  });
});

describe('gating: no candidate request at all', () => {
  it('flag off, signed in, transport on: one request, on the Go path, no beacon', async () => {
    browser(true);
    allTransport(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent[0].url).toContain('/api/trpc-go/image.getInfinite?');
    expect(shadowPushes()).toHaveLength(0);
  });

  it('SSR (no window), flag on: one request', async () => {
    allTransport(true);
    setClientShadowCompareEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(goRequests()).toHaveLength(0);
  });

  it('signed out, flag on: one request (the edge-cacheable path stays alone)', async () => {
    browser(false);
    allTransport(true);
    setClientShadowCompareEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(goRequests()).toHaveLength(0);
  });

  it('a procedure off the allowlist, flag on: one request', async () => {
    shadowOn();
    await callQuery('model.getById', { id: 5 });
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(goRequests()).toHaveLength(0);
  });

  it('a mutation on an allowlisted path, flag on: one request', async () => {
    shadowOn();
    await callMutation(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent[0].method).toBe('POST');
    expect(goRequests()).toHaveLength(0);
  });

  it('an input too large for a GET, flag on: one POST request', async () => {
    shadowOn();
    await callQuery(INFINITE, {
      ...INFINITE_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent[0].method).toBe('POST');
    expect(goRequests()).toHaveLength(0);
  });

  // Shadow only where Go already serves: each procedure needs its OWN transport flag on for this
  // user. Literal per-procedure cases, so a gate keyed on the wrong flag turns one of them red.
  const transportCases: Array<[string, Record<string, unknown>, (on: boolean) => void]> = [
    ['image.getImagesAsPostsInfinite', { modelId: 3, limit: 50 }, setFeedGoTransportEnabled],
    ['model.getAll', MODELS_INPUT, setFeedGoTransportModelGetAllEnabled],
    ['image.getInfinite', INFINITE_INPUT, setFeedGoTransportInfiniteEnabled],
  ];
  for (const [procedure, input, setOwnTransport] of transportCases) {
    it(`${procedure}: its transport flag off, flag on: one request to /api/trpc`, async () => {
      shadowOn();
      // Every OTHER procedure's transport flag stays on: only this one's own flag may count.
      setOwnTransport(false);
      await callQuery(procedure, input);
      await settleAll();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sent[0].url).toContain(`/api/trpc/${procedure}?`);
      expect(goRequests()).toHaveLength(0);
      expect(shadowPushes()).toHaveLength(0);
    });

    it(`${procedure}: its transport flag on, flag on: control on /api/trpc, candidate on the Go path`, async () => {
      browser(true);
      setClientShadowCompareEnabled(true);
      setOwnTransport(true);
      await callQuery(procedure, input);
      await settleAll();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(nodeRequests()[0].url).toContain(`/api/trpc/${procedure}?`);
      expect(goRequests()[0].url).toContain(`/api/trpc-go/${procedure}?`);
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
      expect(shadowPushes()[0][1].context.procedure).toBe(procedure);
    });
  }

  // Control for the block above: the same call with the flag on and nothing else ruling it out
  // does send the candidate, so the zeros above are the gates speaking.
  it('positive control: flag on, signed in, allowlisted GET: two requests', async () => {
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(goRequests()).toHaveLength(1);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });
});

describe('the two legs', () => {
  it('the control leg is byte-for-byte the request the flag-off app sends', async () => {
    // The old route, as a signed-in user with no Go-transport flag sends it.
    browser(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    const flagOff = sent[0];
    expect(flagOff.url).toContain('/api/trpc/image.getInfinite?');

    sent = [];
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    const control = sent.find((s) => s.leg === 'node');

    expect(control?.url).toBe(flagOff.url);
    expect(control?.method).toBe('GET');
    expect(control?.headers).toEqual(flagOff.headers);
    expect(control?.url).not.toContain('batch=1');
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });

  it('in the batch cohort the control leg is still one unbatched GET', async () => {
    shadowOn();
    setTrpcBatchingEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    const control = sent.find((s) => s.leg === 'node');
    expect(control?.url).toContain('/api/trpc/image.getInfinite?');
    expect(control?.url).not.toContain('batch=1');
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });

  it('the candidate asks the same question: same query string, same headers, Go path', async () => {
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    const control = new URL(sent.find((s) => s.leg === 'node')?.url ?? '', 'https://x.invalid');
    const candidate = new URL(goRequests()[0]?.url ?? '', 'https://x.invalid');
    expect(control.pathname).toBe('/api/trpc/image.getInfinite');
    expect(candidate.pathname).toBe('/api/trpc-go/image.getInfinite');
    expect(candidate.search).toBe(control.search);
    expect(candidate.search).toContain('input=');
    expect(goRequests()[0].method).toBe('GET');
    expect(goRequests()[0].headers).toEqual(sent.find((s) => s.leg === 'node')?.headers);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });

  it('both legs start before either answers', async () => {
    shadowOn();
    const nodeGate = gate();
    const goGate = gate();
    replies.node.gate = nodeGate.promise;
    replies.go.gate = goGate.promise;

    const pending = callQuery(INFINITE, INFINITE_INPUT);
    // Neither gate is open, so two requests here means neither waited for the other.
    await vi.waitFor(() => expect(sent.map((s) => s.leg).sort()).toEqual(['go', 'node']));

    nodeGate.open();
    goGate.open();
    expect((await pending).data).toEqual(CONTROL_DATA);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });
});

describe('verdicts', () => {
  it('match: identical raw texts', async () => {
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0]).toEqual([
      {
        type: 'shadow_compare',
        values: { control_ms: 0, candidate_ms: 0, control_bytes: 122, candidate_bytes: 122 },
      },
      {
        skipDedupe: true,
        context: {
          procedure: 'image.getInfinite',
          candidate: 'go-transport',
          verdict: 'match',
          control_status: '200',
          candidate_status: '200',
          candidate_served_by: 'go',
        },
      },
    ]);
  });

  it('mismatch: the first differing path and kind, and each side its own byte length', async () => {
    shadowOn();
    replies.go.body = CANDIDATE_BODY;
    await callQuery(MODELS, MODELS_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    const [payload, options] = shadowPushes()[0];
    expect(payload.values).toEqual({
      control_ms: 0,
      candidate_ms: 0,
      control_bytes: 122,
      candidate_bytes: 123,
    });
    expect(options.context).toEqual({
      procedure: 'model.getAll',
      candidate: 'go-transport',
      verdict: 'mismatch',
      control_status: '200',
      candidate_status: '200',
      candidate_served_by: 'go',
      diff_path: '$.result.data.json.items[1].id',
      diff_kind: 'value',
    });
  });

  it('mismatch on raw bytes even when both parse to the same value (key order)', async () => {
    shadowOn();
    replies.go.body = REORDERED_BODY;
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context).toMatchObject({
      verdict: 'mismatch',
      diff_path: '$.result.data.json',
      diff_kind: 'key_order',
    });
  });

  // The Go service never writes superjson's meta.referentialEqualities
  // (apps/feed-go/internal/superjson), which the Node writer adds when one object instance sits at
  // several paths. Only that member is exempt from the byte compare.
  describe('meta.referentialEqualities', () => {
    const NODE_WITH_REFEQ =
      '{"result":{"data":{"json":{"items":[{"id":4101,"createdAt":"2026-11-20T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}},{"id":4102,"createdAt":"2026-11-21T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"},"meta":{"values":{"items.0.createdAt":["Date"],"items.1.createdAt":["Date"]},"referentialEqualities":{"items.0.user":["items.1.user"]},"v":1}}}}';
    const GO_SAME_VALUE =
      '{"result":{"data":{"json":{"items":[{"id":4101,"createdAt":"2026-11-20T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}},{"id":4102,"createdAt":"2026-11-21T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"},"meta":{"values":{"items.0.createdAt":["Date"],"items.1.createdAt":["Date"]},"v":1}}}}';

    it('a body differing only in referentialEqualities is a match, each side its own byte length', async () => {
      browser(false);
      signedOutShadow(true);
      replies.node.body = NODE_WITH_REFEQ;
      replies.go.body = GO_SAME_VALUE;
      await callQuery(INFINITE, INFINITE_INPUT);
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
      const [payload, options] = shadowPushes()[0];
      expect(payload.values).toEqual({
        control_ms: 0,
        candidate_ms: 0,
        control_bytes: 382,
        candidate_bytes: 324,
      });
      expect(options.context).toEqual({
        procedure: 'image.getInfinite',
        candidate: 'go-transport',
        verdict: 'match',
        control_status: '200',
        candidate_status: '200',
        candidate_served_by: 'go',
        viewer: 'signed_out',
      });
    });

    it('a meta holding only referentialEqualities matches an answer with no meta', async () => {
      shadowOn();
      replies.node.body =
        '{"result":{"data":{"json":{"items":[{"id":4101,"user":{"id":9,"cosmetics":[{"id":7}]}},{"id":4102,"user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"},"meta":{"referentialEqualities":{"items.0.user":["items.1.user"]},"v":1}}}}';
      replies.go.body =
        '{"result":{"data":{"json":{"items":[{"id":4101,"user":{"id":9,"cosmetics":[{"id":7}]}},{"id":4102,"user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"}}}}';
      await callQuery(INFINITE, INFINITE_INPUT);
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
      expect(shadowPushes()[0][1].context.verdict).toBe('match');
    });

    it('a real value difference beside it is still a mismatch, at that value', async () => {
      shadowOn();
      replies.node.body = NODE_WITH_REFEQ;
      replies.go.body =
        '{"result":{"data":{"json":{"items":[{"id":4101,"createdAt":"2026-11-20T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}},{"id":41020,"createdAt":"2026-11-21T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"},"meta":{"values":{"items.0.createdAt":["Date"],"items.1.createdAt":["Date"]},"v":1}}}}';
      await callQuery(INFINITE, INFINITE_INPUT);
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
      expect(shadowPushes()[0][1].context).toMatchObject({
        verdict: 'mismatch',
        diff_path: '$.result.data.json.items[1].id',
        diff_kind: 'value',
      });
    });

    it('meta.values is still compared: an answer missing its Date annotations is a mismatch', async () => {
      shadowOn();
      replies.node.body = NODE_WITH_REFEQ;
      replies.go.body =
        '{"result":{"data":{"json":{"items":[{"id":4101,"createdAt":"2026-11-20T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}},{"id":4102,"createdAt":"2026-11-21T08:00:00.000Z","user":{"id":9,"cosmetics":[{"id":7}]}}],"nextCursor":"n-88"}}}}';
      await callQuery(INFINITE, INFINITE_INPUT);
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
      expect(shadowPushes()[0][1].context).toMatchObject({
        verdict: 'mismatch',
        diff_path: '$.result.data.meta',
        diff_kind: 'missing_in_candidate',
      });
    });
  });

  it('candidate_fallback: the Go service handed it to Node, so identical bytes are not a match', async () => {
    shadowOn();
    replies.go = { status: 200, body: CONTROL_BODY, servedBy: 'node' };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0]).toEqual([
      {
        type: 'shadow_compare',
        values: { control_ms: 0, candidate_ms: 0, control_bytes: 122, candidate_bytes: 122 },
      },
      {
        skipDedupe: true,
        context: {
          procedure: 'image.getInfinite',
          candidate: 'go-transport',
          verdict: 'candidate_fallback',
          control_status: '200',
          candidate_status: '200',
          candidate_served_by: 'node',
        },
      },
    ]);
  });

  it('candidate_fallback: a different body from a fallback is not a mismatch either', async () => {
    shadowOn();
    replies.go = { status: 200, body: CANDIDATE_BODY, servedBy: 'node' };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    const context = shadowPushes()[0][1].context;
    expect(context.verdict).toBe('candidate_fallback');
    expect(context.diff_path).toBeUndefined();
  });

  it('candidate_fallback: no served-by header at all (the request never reached the Go service)', async () => {
    shadowOn();
    replies.go = { status: 200, body: CONTROL_BODY, servedBy: null };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context).toMatchObject({
      verdict: 'candidate_fallback',
      candidate_served_by: 'absent',
    });
  });

  it('candidate_fallback: an unknown served-by value is not trusted as Go, and is not beaconed', async () => {
    shadowOn();
    replies.go = { status: 200, body: CONTROL_BODY, servedBy: 'zq-unknown-value' };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context).toMatchObject({
      verdict: 'candidate_fallback',
      candidate_served_by: 'other',
    });
  });

  it('candidate_error: the candidate answered 502', async () => {
    shadowOn();
    replies.go = { status: 502, body: '<html>bad gateway</html>' };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    const [payload, options] = shadowPushes()[0];
    expect(options.context).toEqual({
      procedure: 'image.getInfinite',
      candidate: 'go-transport',
      verdict: 'candidate_error',
      control_status: '200',
      candidate_status: '502',
    });
    expect(payload.values).toEqual({ control_ms: 0, candidate_ms: 0, control_bytes: 122 });
  });

  it('candidate_error: the candidate request failed outright (no status)', async () => {
    shadowOn();
    replies.go = { status: 200, body: '', reject: new TypeError('Failed to fetch') };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context).toEqual({
      procedure: 'image.getInfinite',
      candidate: 'go-transport',
      verdict: 'candidate_error',
      control_status: '200',
    });
  });

  it('control_error: the control answered 500, whatever the candidate said', async () => {
    shadowOn();
    replies.node = { status: 500, body: ERROR_500_BODY };
    const outcome = await callQuery(INFINITE, INFINITE_INPUT);
    expect(outcome.error).toBeDefined();
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context).toEqual({
      procedure: 'image.getInfinite',
      candidate: 'go-transport',
      verdict: 'control_error',
      control_status: '500',
      candidate_status: '200',
      candidate_served_by: 'go',
    });
  });

  it('control_error: the control request failed outright', async () => {
    shadowOn();
    replies.node = { status: 200, body: '', reject: new TypeError('Failed to fetch') };
    const outcome = await callQuery(INFINITE, INFINITE_INPUT);
    expect(outcome.error).toBeDefined();
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][1].context.verdict).toBe('control_error');
    expect(shadowPushes()[0][1].context.control_status).toBeUndefined();
  });

  it('latencies are each leg from the shared start', async () => {
    shadowOn();
    const nodeGate = gate();
    const goGate = gate();
    replies.node.gate = nodeGate.promise;
    replies.go.gate = goGate.promise;

    // No `vi.waitFor` until both legs have read their clocks: under fake timers it advances the
    // clock on every check, which would add to both latencies.
    const pending = callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(120);
    nodeGate.open();
    await pending;
    await settleAll();
    vi.advanceTimersByTime(230);
    goGate.open();
    // The candidate reads its clock once its body is read; the hash after that runs off-thread
    // and can take longer than a few event-loop turns, so only then poll.
    await settleAll();
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(shadowPushes()[0][0].values).toMatchObject({ control_ms: 120, candidate_ms: 350 });
  });
});

describe('candidate_timeout', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  });

  it('a candidate that never answers is aborted at 10 s and beaconed as a timeout', async () => {
    shadowOn();
    replies.go = { status: 200, body: CANDIDATE_BODY, hang: true };
    const outcome = await callQuery(INFINITE, INFINITE_INPUT);
    // The app had its answer long before the candidate gave up.
    expect(outcome.data).toEqual(CONTROL_DATA);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(shadowPushes()).toHaveLength(0);
    expect(goRequests()[0].signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(goRequests()[0].signal?.aborted).toBe(true);
    const [payload, options] = shadowPushes()[0];
    expect(options.context).toEqual({
      procedure: 'image.getInfinite',
      candidate: 'go-transport',
      verdict: 'candidate_timeout',
      control_status: '200',
    });
    expect(payload.values).toEqual({ control_ms: 0, candidate_ms: 10_000, control_bytes: 122 });
  });

  it('a candidate that never answers does not hold the caller', async () => {
    shadowOn();
    replies.go = { status: 200, body: CANDIDATE_BODY, hang: true };
    const outcome = await callQuery(INFINITE, INFINITE_INPUT);
    expect(outcome.error).toBeUndefined();
    expect(outcome.data).toEqual(CONTROL_DATA);
    expect(shadowPushes()).toHaveLength(0);
    // Drain the candidate's timer inside this test.
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });
});

describe('the app only ever gets the control leg', () => {
  const candidateFailures: Array<[string, Reply]> = [
    ['a different body', { status: 200, body: CANDIDATE_BODY }],
    ['a 500', { status: 500, body: ERROR_500_BODY }],
    ['a network failure', { status: 200, body: '', reject: new TypeError('Failed to fetch') }],
    ['a body that is not JSON', { status: 200, body: '<html>oops</html>' }],
  ];

  for (const [name, reply] of candidateFailures) {
    it(`candidate gave ${name}: the caller gets the control's data`, async () => {
      shadowOn();
      replies.go = reply;
      const outcome = await callQuery(INFINITE, INFINITE_INPUT);
      expect(outcome.error).toBeUndefined();
      expect(outcome.data).toEqual(CONTROL_DATA);
      // Compared with the flag off: the same data.
      await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    });
  }

  it('a control error reaches the caller as the same error it would without the flag', async () => {
    browser(true);
    replies.node = { status: 500, body: ERROR_500_BODY };
    const flagOff = await callQuery(INFINITE, INFINITE_INPUT);

    shadowOn();
    const flagOn = await callQuery(INFINITE, INFINITE_INPUT);
    expect((flagOn.error as Error).message).toBe((flagOff.error as Error).message);
    expect((flagOn.error as Error).message).toBe('boom');
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });

  it('a cancelled query cancels the candidate and beacons nothing', async () => {
    shadowOn();
    replies.node = { status: 200, body: CONTROL_BODY, hang: true };
    replies.go = { status: 200, body: CONTROL_BODY, hang: true };
    const controller = new AbortController();
    const pending = callQuery(INFINITE, INFINITE_INPUT, controller.signal);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    controller.abort();
    await pending;
    await settleAll();
    expect(goRequests()[0].signal?.aborted).toBe(true);
    expect(shadowPushes()).toHaveLength(0);
  });
});

describe('per page-load cap', () => {
  it('stops sending candidates after 20 compares', async () => {
    shadowOn();
    for (let i = 0; i < 21; i++) await callQuery(INFINITE, { ...INFINITE_INPUT, cursor: i });
    await settleAll();
    // 20 compares (a control and a candidate each), then the 21st goes on the Go path alone.
    expect(nodeRequests()).toHaveLength(20);
    expect(goRequests()).toHaveLength(21);
    expect(fetchMock).toHaveBeenCalledTimes(41);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(20));
  });

  it('holds under concurrent queries, which all pass the link check before any is sent', async () => {
    shadowOn();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => callQuery(INFINITE, { ...INFINITE_INPUT, cursor: i }))
    );
    await settleAll();
    // All 25 took the shadow link; the 5 past the cap are sent as the control alone.
    expect(goRequests()).toHaveLength(20);
    expect(nodeRequests()).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(45);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(20));
  });
});

describe('no response value ever reaches a beacon', () => {
  const SENTINEL = 'zq-sentinel-7319';

  it('across every verdict, with the sentinel in the bodies, a key, the input and an error', async () => {
    shadowOn();
    const input = { ...INFINITE_INPUT, username: SENTINEL };
    const body = (name: string) =>
      JSON.stringify({
        result: {
          data: { json: { items: [{ id: 1, name }], meta: { [`${SENTINEL}@k`]: name } } },
        },
      });

    // match
    replies.node = { status: 200, body: body(`${SENTINEL}-a`) };
    replies.go = { status: 200, body: body(`${SENTINEL}-a`) };
    await callQuery(INFINITE, input);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    // mismatch at a value carrying the sentinel
    replies.go = { status: 200, body: body(`${SENTINEL}-b`) };
    await callQuery(INFINITE, input);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(2));
    // mismatch under a key carrying the sentinel
    replies.go = {
      status: 200,
      body: JSON.stringify({
        result: {
          data: {
            json: { items: [{ id: 1, name: `${SENTINEL}-a` }], meta: { [`${SENTINEL}@k`]: 0 } },
          },
        },
      }),
    };
    await callQuery(INFINITE, input);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(3));
    // candidate_error whose error message carries the sentinel
    replies.go = { status: 200, body: '', reject: new Error(`refused ${SENTINEL}`) };
    await callQuery(INFINITE, input);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(4));
    // control_error whose body carries the sentinel
    replies.node = {
      status: 500,
      body: JSON.stringify({
        error: {
          json: {
            message: SENTINEL,
            code: -32603,
            data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
          },
        },
      }),
    };
    replies.go = { status: 200, body: body(SENTINEL) };
    await callQuery(INFINITE, input);

    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(5));
    // Positive controls: the sentinel was on the wire, and the beacons are the ones expected.
    expect(sent.every((s) => s.url.includes(SENTINEL))).toBe(true);
    expect(shadowPushes().map(([, o]) => o.context.verdict)).toEqual([
      'match',
      'mismatch',
      'mismatch',
      'candidate_error',
      'control_error',
    ]);
    expect(shadowPushes()[1][1].context.diff_path).toBe('$.result.data.json.items[0].name');
    expect(shadowPushes()[2][1].context.diff_path).toBe('$.result.data.json.meta.*');

    // Every measurement this run pushed, not only the shadow ones.
    expect(h.pushMeasurement.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of h.pushMeasurement.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(SENTINEL);
    }
  });

  it('a user-chosen key shaped like a field name is masked, never beaconed', async () => {
    // Letters, digits and underscores: the shape a regex mask would have reported verbatim.
    const USER_KEY = 'my_private_tag_7319';
    shadowOn();
    const body = (value: number) =>
      JSON.stringify({
        result: { data: { json: { items: [{ id: 1, meta: { [USER_KEY]: value } }] } } },
      });
    replies.node = { status: 200, body: body(1) };
    replies.go = { status: 200, body: body(2) };
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));

    // Positive control: the key was in both bodies, and the walk reached it (the known field names
    // above it are spelled out).
    expect(replies.node.body).toContain(USER_KEY);
    expect(shadowPushes()[0][1].context.verdict).toBe('mismatch');
    expect(shadowPushes()[0][1].context.diff_path).toBe('$.result.data.json.items[0].meta.*');
    for (const call of h.pushMeasurement.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(USER_KEY);
    }
  });
});

describe('a pluggable candidate', () => {
  const controlResponse = () =>
    new Response(CONTROL_BODY, { status: 200, headers: { 'content-type': 'application/json' } });

  it('its id is what the beacon carries, and its answer is compared', async () => {
    const pushMeasurement = vi.fn();
    const requests: string[] = [];
    const candidate: ShadowCandidate = {
      id: 'registry-sdk-test',
      supports: (procedure) => procedure === 'image.getInfinite',
      send: async ({ controlUrl }): Promise<ShadowLegResponse> => {
        requests.push(controlUrl);
        return { status: 200, text: CANDIDATE_BODY };
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => controlResponse())
    );
    const shadowFetch = createShadowCompareFetch({
      procedure: 'image.getInfinite',
      candidate,
      pushMeasurement,
    });

    const response = await shadowFetch('/api/trpc/image.getInfinite?input=%7B%7D', {});
    expect(await response.text()).toBe(CONTROL_BODY);
    await vi.waitFor(() => expect(pushMeasurement).toHaveBeenCalledTimes(1));
    expect(requests).toEqual(['/api/trpc/image.getInfinite?input=%7B%7D']);
    expect(pushMeasurement.mock.calls[0][1].context).toMatchObject({
      candidate: 'registry-sdk-test',
      verdict: 'mismatch',
    });
  });

  it('a candidate that throws synchronously cannot reach the control response', async () => {
    const pushMeasurement = vi.fn();
    const candidate: ShadowCandidate = {
      id: 'throws-test',
      supports: () => true,
      send: (() => {
        throw new Error('sync');
      }) as unknown as ShadowCandidate['send'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => controlResponse())
    );
    const shadowFetch = createShadowCompareFetch({
      procedure: 'image.getInfinite',
      candidate,
      pushMeasurement,
    });
    const response = await shadowFetch('/api/trpc/image.getInfinite?input=%7B%7D', {});
    expect(await response.text()).toBe(CONTROL_BODY);
    await vi.waitFor(() => expect(pushMeasurement).toHaveBeenCalledTimes(1));
    expect(pushMeasurement.mock.calls[0][1].context.verdict).toBe('candidate_error');
  });

  it('a candidate that does not support the procedure is never asked and spends no cap', async () => {
    const send = vi.fn();
    const candidate: ShadowCandidate = { id: 'unsupported-test', supports: () => false, send };
    const control = vi.fn(async () => controlResponse());
    vi.stubGlobal('fetch', control);
    const shadowFetch = createShadowCompareFetch({ procedure: 'image.getInfinite', candidate });
    for (let i = 0; i < 25; i++) await shadowFetch('/api/trpc/image.getInfinite?input=%7B%7D', {});
    expect(send).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledTimes(25);

    // The cap is untouched: the real link still sends a candidate afterwards.
    vi.stubGlobal('fetch', fetchMock);
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(goRequests()).toHaveLength(1);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
  });
});

/**
 * The signed-out cohort: a browser rendered as signed out shadows only under its own flags
 * (`clientShadowCompareSignedOut` with that procedure's signed-out transport flag), and its beacon
 * says so (`viewer: 'signed_out'`) and carries both legs' edge-cache verdicts, since a signed-out
 * answer can be a stored copy on either path.
 */
describe('signed out', () => {
  it('shadows under the signed-out flags, beaconing viewer and both cache verdicts', async () => {
    browser(false);
    signedOutShadow(true);
    replies.node = { status: 200, body: CONTROL_BODY, cache: 'HIT' };
    replies.go = { status: 200, body: CONTROL_BODY, cache: 'MISS' };
    const outcome = await callQuery(INFINITE, INFINITE_INPUT);
    expect(outcome.data).toEqual(CONTROL_DATA);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect(sent.map((s) => s.leg).sort()).toEqual(['go', 'node']);
    expect(shadowPushes()[0][1].context).toEqual({
      procedure: 'image.getInfinite',
      candidate: 'go-transport',
      verdict: 'match',
      control_status: '200',
      candidate_status: '200',
      candidate_served_by: 'go',
      viewer: 'signed_out',
      control_cache: 'hit',
      candidate_cache: 'miss',
    });
  });

  it('an unknown cache verdict is beaconed as other, an absent one not at all', async () => {
    browser(false);
    signedOutShadow(true);
    replies.node = { status: 200, body: CONTROL_BODY, cache: 'SOMETHING-NEW' };
    await callQuery(MODELS, MODELS_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    const { context } = shadowPushes()[0][1];
    expect(context.control_cache).toBe('other');
    expect('candidate_cache' in context).toBe(false);
    expect(context.viewer).toBe('signed_out');
  });

  it('the signed-in shadow and transport flags do not shadow a signed-out browser', async () => {
    browser(false);
    allTransport(true);
    setClientShadowCompareEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(shadowPushes()).toHaveLength(0);
    expect(sent.map((s) => s.leg)).toEqual(['node']);
  });

  it('the signed-out flags do not shadow a signed-in browser, whose beacon stays as it was', async () => {
    browser(true);
    signedOutShadow(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(shadowPushes()).toHaveLength(0);
    expect(sent.map((s) => s.leg)).toEqual(['node']);

    // Positive control: the signed-in flags do shadow it, with no `viewer` on the beacon.
    shadowOn();
    await callQuery(INFINITE, INFINITE_INPUT);
    await vi.waitFor(() => expect(shadowPushes()).toHaveLength(1));
    expect('viewer' in shadowPushes()[0][1].context).toBe(false);
  });

  it('the signed-out transport flag alone (shadow flag off) sends the Go leg only', async () => {
    browser(false);
    setFeedGoTransportSignedOutInfiniteEnabled(true);
    await callQuery(INFINITE, INFINITE_INPUT);
    await settleAll();
    expect(shadowPushes()).toHaveLength(0);
    expect(sent.map((s) => s.leg)).toEqual(['go']);
  });
});
