import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BLOCK_TOKEN_QUERY_PROCEDURES } from '~/shared/constants/block-token-transport.constants';
import {
  CACHEABLE_PROCEDURES,
  NEVER_BATCH_PROCEDURES,
  setTrpcBatchingEnabled,
  trpcVanilla,
} from '~/utils/trpc';

/**
 * WIRE-LEVEL coverage for how the browser client sends block-token queries.
 *
 * Every procedure in `BLOCK_TOKEN_QUERY_PROCEDURES` is a QUERY whose input carries a bearer
 * block token. A tRPC query defaults to GET with the input in `?input=`, which puts the token in
 * the request URL. The client must send these as POST (input in the body) and never batch them
 * (the batch link sends queries as GET too).
 *
 * Drives the real `trpcVanilla` client — the same link chain the app's `trpc` client builds — over
 * a stubbed `fetch`, and asserts on the HTTP request it actually made: method, URL, body. Nothing
 * about routing is re-declared here, so a change to the link's routing is visible to these
 * assertions whichever function it lives in.
 */

type Sent = { url: string; method: string; body: string | undefined };
let sent: Sent[] = [];

const TOKEN = 'header.payload.signature-test-token';

beforeEach(() => {
  sent = [];
  setTrpcBatchingEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({
        url: String(url),
        method: (init?.method ?? 'GET').toUpperCase(),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(JSON.stringify({ result: { data: { json: null } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
});

afterEach(() => {
  setTrpcBatchingEnabled(false);
  delete (globalThis as { window?: unknown }).window;
  vi.unstubAllGlobals();
});

/** Call a procedure by its dotted path through the real client; the response is irrelevant. */
async function callQuery(path: string, input: Record<string, unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = trpcVanilla;
  for (const segment of path.split('.')) node = node[segment];
  try {
    await node.query(input);
  } catch {
    // The stub's response is not a valid payload for every link; only the request matters.
  }
}

/** Smallest input each procedure accepts, so size can never be what routes it to POST. */
const smallInput = (path: string): Record<string, unknown> => ({
  blockToken: TOKEN,
  ...(path.endsWith('.get') || path.endsWith('.getCount') ? { key: 'k' } : {}),
  ...(path.endsWith('.getCounts') ? { keys: ['k'] } : {}),
});

const ALL = [...BLOCK_TOKEN_QUERY_PROCEDURES].sort();

/**
 * The positive controls' procedure: a real query in NONE of the routing sets, so it takes the
 * default route (GET; batched in the cohort). Pinned by the test below so it cannot drift into
 * a set and turn a control red for a reason unrelated to block tokens.
 */
const ORDINARY = 'model.getById';
const ORDINARY_INPUT = { id: 1 };

it('the controls use a procedure in none of the routing sets', () => {
  expect(BLOCK_TOKEN_QUERY_PROCEDURES.has(ORDINARY)).toBe(false);
  expect(CACHEABLE_PROCEDURES.has(ORDINARY)).toBe(false);
  expect(NEVER_BATCH_PROCEDURES.has(ORDINARY)).toBe(false);
});

describe('block-token queries leave the browser as POST', () => {
  it('covers all eight procedures (the set is not silently empty)', () => {
    expect(ALL).toHaveLength(8);
  });

  it.each(ALL)('%s goes out as POST with the token in the body, not the URL', async (path) => {
    await callQuery(path, smallInput(path));

    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request.method).toBe('POST');
    expect(request.url).not.toContain(TOKEN);
    expect(request.url).not.toContain('input=');
    expect(request.body).toContain(TOKEN);
  });

  it('POSITIVE CONTROL: an ordinary small query still goes out as GET with ?input=', async () => {
    // Same client, same stub, one variable changed (the procedure). Without this, "POST" above
    // is indistinguishable from a client that POSTs everything — which would also de-cache
    // every public query.
    await callQuery(ORDINARY, ORDINARY_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('input=');
  });
});

describe('block-token queries are never batched', () => {
  beforeEach(() => {
    // The batch cohort: flag on AND an authenticated browser.
    setTrpcBatchingEnabled(true);
    (globalThis as { window?: unknown }).window = { isAuthed: true };
  });

  it.each(ALL)('%s goes out unbatched as POST even in the batch cohort', async (path) => {
    await callQuery(path, smallInput(path));

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).not.toContain('batch=1');
    expect(sent[0].url).not.toContain(TOKEN);
  });

  it('POSITIVE CONTROL: an ordinary query in the batch cohort IS batched (GET ?batch=1)', async () => {
    // Proves the cohort setup above actually reaches the batch link, so "not batched" for the
    // block-token procedures is a property of those procedures, not of a dead setup.
    await callQuery(ORDINARY, ORDINARY_INPUT);

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('GET');
    expect(sent[0].url).toContain('batch=1');
  });
});
