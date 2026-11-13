import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NEVER_BATCH_PROCEDURES, setTrpcBatchingEnabled, trpcVanilla } from '~/utils/trpc';
import {
  GO_TRANSPORT_PROCEDURES,
  GO_TRANSPORT_URL,
  setFeedGoTransportEnabled,
} from '~/utils/trpc-go-transport';

/**
 * WIRE-LEVEL coverage for the `feedGoTransport` flag: with it on, a signed-in browser sends
 * `image.getImagesAsPostsInfinite` to `/api/trpc-go/…` instead of `/api/trpc/…`; everything else is
 * unchanged. Drives the real `trpcVanilla` link chain over a stubbed `fetch` and asserts on the URL it
 * actually requested, as trpc-block-token-transport.test.ts does.
 */

type Sent = { url: string; method: string };
let sent: Sent[] = [];

const FEED = 'image.getImagesAsPostsInfinite';
const FEED_INPUT = { modelId: 1, modelVersionId: 2, limit: 50 };
const ORDINARY = 'model.getById';
const ORDINARY_INPUT = { id: 1 };

beforeEach(() => {
  sent = [];
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), method: (init?.method ?? 'GET').toUpperCase() });
      return new Response(JSON.stringify({ result: { data: { json: null } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  setFeedGoTransportEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

async function callQuery(path: string, input: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.query(input);
  } catch {
    // Only the request matters.
  }
}

const signIn = () => {
  (globalThis as { window?: unknown }).window = { isAuthed: true };
};

it('every Go-transport procedure is also never batched (a batched path cannot be routed)', () => {
  expect(GO_TRANSPORT_PROCEDURES.size).toBeGreaterThan(0);
  for (const path of GO_TRANSPORT_PROCEDURES) expect(NEVER_BATCH_PROCEDURES.has(path)).toBe(true);
});

describe('feedGoTransport', () => {
  it('OFF (the default): the feed goes to /api/trpc as before', async () => {
    signIn();
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain(`/api/trpc/${FEED}?`);
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });

  it('ON, signed in: the feed goes to the Go transport path as a GET', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain(`${GO_TRANSPORT_URL}/${FEED}?`);
    expect(sent[0].url).toContain('input=');
  });

  it('ON, signed in, in the batch cohort: still unbatched on the Go path', async () => {
    signIn();
    setTrpcBatchingEnabled(true);
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`${GO_TRANSPORT_URL}/${FEED}?`);
    expect(sent[0].url).not.toContain('batch=1');
  });

  it('ON, signed out: the feed stays on /api/trpc (edge-cacheable path)', async () => {
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, FEED_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`/api/trpc/${FEED}?`);
  });

  it('ON, signed in: other procedures are unaffected', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(ORDINARY, ORDINARY_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain(`/api/trpc/${ORDINARY}?`);
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });

  it('ON, signed in: an input too large for a GET stays on /api/trpc as POST', async () => {
    signIn();
    setFeedGoTransportEnabled(true);
    await callQuery(FEED, {
      ...FEED_INPUT,
      excludedTagIds: Array.from({ length: 800 }, (_, i) => i),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain(GO_TRANSPORT_URL);
  });
});
