import { trace, type Span } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { CandidateFilter } from '~/server/services/semantic-search-client';

const h = vi.hoisted(() => ({ auditFlag: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: async (flag: string) => flag === 'semantic-search-audit' && h.auditFlag,
}));

const { searchServiceSource } = await import('~/server/services/semantic-search-client');

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const filter: CandidateFilter = { gate: { kind: 'level', nsfwLevels: [1, 2] } };

let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
let reply: Record<string, unknown>;
beforeEach(() => {
  setEnv({ SEARCH_SERVICE_URL: 'http://search.test' });
  h.auditFlag = false;
  sent = [];
  reply = { corrected: 'fox', changes: [], hits: [{ id: 3 }] };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return Response.json(url.includes('/qdrant/') ? { result: { points: [{ id: 4 }] } } : reply);
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Runs `fn` as an instrumented request would: with an active span carrying TRACE_ID. */
async function inTrace<T>(fn: () => Promise<T>) {
  const span = trace.wrapSpanContext({
    traceId: TRACE_ID,
    spanId: 'b7ad6b7169203331',
    traceFlags: 1,
  });
  const active = vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as Span);
  try {
    return await fn();
  } finally {
    active.mockRestore();
  }
}

const textSearch = (isModerator: boolean) =>
  inTrace(() =>
    searchServiceSource('images')({
      query: { text: 'fox' },
      filter,
      offset: 0,
      limit: 10,
      viewer: { isModerator },
    })
  );

describe('what the search service is told about the viewer', () => {
  it('sends the request id, levels and moderator status from the session when the flag is on', async () => {
    h.auditFlag = true;
    await textSearch(true);
    expect(sent[0].headers['x-request-id']).toBe(TRACE_ID);
    expect(sent[0].body).toMatchObject({ browsing_levels: [1, 2], viewer_is_moderator: true });
  });

  it('tells the service a non-moderator is one', async () => {
    h.auditFlag = true;
    await textSearch(false);
    expect(sent[0].body.viewer_is_moderator).toBe(false);
  });

  it('sends the request it always has with the flag off', async () => {
    await textSearch(true);
    expect(sent[0].headers['x-request-id']).toBeUndefined();
    expect(sent[0].body).not.toHaveProperty('browsing_levels');
    expect(sent[0].body).not.toHaveProperty('viewer_is_moderator');
  });

  it('sends the request id, but no viewer fields, to the "more like this" pass-through', async () => {
    h.auditFlag = true;
    await inTrace(() =>
      searchServiceSource('images')({
        query: { similarTo: 9 },
        filter,
        offset: 0,
        limit: 10,
        viewer: { isModerator: true },
      })
    );
    expect(sent[0].url).toContain('/qdrant/');
    expect(sent[0].headers['x-request-id']).toBe(TRACE_ID);
    expect(sent[0].body).not.toHaveProperty('viewer_is_moderator');
  });
});

describe("reading the guard's verdict", () => {
  it('reads the full guard result', async () => {
    reply.guard = {
      refused: false,
      outcome: 'flag',
      rules: ['block:rule_a'],
      mode: 'shadow',
      version: 'v1',
      scores: { rule_a: 0.9 },
    };
    expect((await textSearch(false)).guard).toEqual({
      outcome: 'flag',
      rules: ['block:rule_a'],
      mode: 'shadow',
      version: 'v1',
    });
  });

  it.each([
    ['no guard field', undefined],
    ["a refusal-only guard (today's service)", { refused: true }],
    ['an outcome it does not know', { outcome: 'maybe', rules: ['block:rule_a'] }],
  ])('reads %s as unknown', async (_, guard) => {
    reply.guard = guard;
    expect((await textSearch(false)).guard).toEqual({
      outcome: 'unknown',
      rules: [],
      mode: '',
      version: null,
    });
  });

  it('records no guard for "more like this", which is not judged in the request', async () => {
    const result = await searchServiceSource('images')({
      query: { similarTo: 9 },
      filter,
      offset: 0,
      limit: 10,
      viewer: { isModerator: false },
    });
    expect(result.guard?.outcome).toBe('none');
  });
});
