import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_PAGE_CAP,
  CONVERSATIONS_PER_PAGE,
  getFreshdeskContact,
  getPublicAgentReplies,
} from '../freshdesk.service';

/**
 * The pre-fill read behind a `resolved` answer, against a stubbed `fetch` — no Freshdesk call is made.
 * What it must never do: offer a customer's message or an internal note as the agent's answer, or
 * report "could not ask" as "no reply".
 */

const saved = { key: process.env.FRESHDESK_API_KEY, domain: process.env.FRESHDESK_DOMAIN };
let fetchMock: ReturnType<typeof vi.fn>;

const convo = (over: Record<string, unknown>) => ({
  id: 150003911207,
  incoming: false,
  private: false,
  body_text: 'Clear the cache and sign in again.',
  created_at: '2026-10-01T10:00:00Z',
  ...over,
});
const page = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

beforeEach(() => {
  process.env.FRESHDESK_API_KEY = 'test-key';
  process.env.FRESHDESK_DOMAIN = 'help.example.test';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of [
    ['FRESHDESK_API_KEY', saved.key],
    ['FRESHDESK_DOMAIN', saved.domain],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe('getPublicAgentReplies', () => {
  it('keeps ONLY public agent replies — not the customer, not a note, not an unknown', async () => {
    fetchMock.mockResolvedValueOnce(
      page([
        convo({ id: 11, body_text: 'agent public' }),
        convo({ id: 12, incoming: true, body_text: 'customer message' }),
        convo({ id: 13, private: true, body_text: 'internal note' }),
        convo({ id: 14, incoming: undefined, body_text: 'incoming unknown' }),
        convo({ id: 15, private: undefined, body_text: 'private unknown' }),
        convo({ id: 16, incoming: true, private: true, body_text: 'customer + private' }),
      ])
    );
    const out = await getPublicAgentReplies('73618');
    expect(out).toEqual({
      status: 'found',
      replies: [{ conversationId: '11', createdAt: '2026-10-01T10:00:00Z', text: 'agent public' }],
      truncated: false,
    });
  });

  it('asks the configured host for that ticket, with the key as basic auth', async () => {
    fetchMock.mockResolvedValueOnce(page([]));
    await getPublicAgentReplies('73618');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://help.example.test/api/v2/tickets/73618/conversations?per_page=${CONVERSATIONS_PER_PAGE}&page=1`
    );
    expect(init.headers.authorization).toBe(
      `Basic ${Buffer.from('test-key:X').toString('base64')}`
    );
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('pages until a short page, and orders newest first', async () => {
    const full = Array.from({ length: CONVERSATIONS_PER_PAGE }, (_, i) =>
      convo({ id: 1000 + i, created_at: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00Z` })
    );
    fetchMock
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(
        page([convo({ id: 9001, created_at: '2026-10-05T00:00:00Z', body_text: 'latest' })])
      );
    const out = await getPublicAgentReplies('73618');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/[?&]page=2$/);
    expect(out.status).toBe('found');
    if (out.status !== 'found') return;
    expect(out.replies).toHaveLength(CONVERSATIONS_PER_PAGE + 1);
    expect(out.replies[0]).toMatchObject({ conversationId: '9001', text: 'latest' });
    expect(out.truncated).toBe(false);
  });

  it('stops at the page cap, and says the list may be missing replies', async () => {
    const full = Array.from({ length: CONVERSATIONS_PER_PAGE }, (_, i) => convo({ id: 1 + i }));
    fetchMock.mockImplementation(async () => page(full));
    const out = await getPublicAgentReplies('73618');
    expect(fetchMock).toHaveBeenCalledTimes(CONVERSATION_PAGE_CAP);
    expect(out).toMatchObject({ status: 'found', truncated: true });
  });

  it("is unavailable, not 'none', when the cap cut the read short and nothing read is a reply", async () => {
    const full = Array.from({ length: CONVERSATIONS_PER_PAGE }, (_, i) =>
      convo({ id: 1 + i, incoming: true })
    );
    fetchMock.mockImplementation(async () => page(full));
    const out = await getPublicAgentReplies('73618');
    expect(out.status).toBe('unavailable');
    expect(out.status === 'unavailable' && out.reason).toMatch(/Only the first 500 conversations/);
  });

  it("is 'none' when the ticket has no public agent reply", async () => {
    fetchMock.mockResolvedValueOnce(page([convo({ incoming: true }), convo({ private: true })]));
    expect(await getPublicAgentReplies('73618')).toEqual({ status: 'none' });
  });

  it('drops a reply with no text or no usable id', async () => {
    fetchMock.mockResolvedValueOnce(
      page([convo({ id: 21, body_text: '   ' }), convo({ id: undefined }), convo({ id: 'x9' })])
    );
    expect(await getPublicAgentReplies('73618')).toEqual({ status: 'none' });
  });

  // 🔴 Every one of these is "could not ask" — never "no reply".
  it.each([
    [
      'a 404 (deleted or merged ticket)',
      () => new Response('{}', { status: 404 }),
      /deleted or merged/,
    ],
    [
      'a 429, with its retry-after',
      () => new Response('{}', { status: 429, headers: { 'retry-after': '37' } }),
      /rate limit.*37s/,
    ],
    ['a 500', () => new Response('{}', { status: 500 }), /returned 500/],
    ['a non-array body', () => page({ errors: [] }), /unexpected/],
  ])('is unavailable on %s', async (_label, response, reason) => {
    fetchMock.mockResolvedValueOnce(response());
    const out = await getPublicAgentReplies('73618');
    expect(out.status).toBe('unavailable');
    expect(out.status === 'unavailable' && out.reason).toMatch(reason);
  });

  it('is unavailable on a timeout or network error', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect((await getPublicAgentReplies('73618')).status).toBe('unavailable');
  });

  it('is unavailable, without asking, when no key is configured or the id is not one', async () => {
    delete process.env.FRESHDESK_API_KEY;
    expect(await getPublicAgentReplies('73618')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk is not configured.',
    });
    process.env.FRESHDESK_API_KEY = 'test-key';
    expect((await getPublicAgentReplies('73618/../contacts')).status).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Shares the request helper with the reads above, so its outcomes are pinned here too.
describe('getFreshdeskContact', () => {
  it('finds the first contact, linked on the configured host', async () => {
    fetchMock.mockResolvedValueOnce(
      page({ results: [{ id: 4411, name: 'R. Vale', email: 'rv@example.test' }] })
    );
    expect(await getFreshdeskContact('rv@example.test')).toEqual({
      status: 'found',
      contact: {
        id: 4411,
        name: 'R. Vale',
        email: 'rv@example.test',
        createdAt: null,
        url: 'https://help.example.test/a/contacts/4411',
      },
    });
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^https:\/\/help\.example\.test\/api\/v2\/search\/contacts\?query=/
    );
  });

  it.each([
    ['null', null],
    ['an array', []],
  ])('is unavailable, not none, on a body that is %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(page(body));
    expect(await getFreshdeskContact('rv@example.test')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk returned an unexpected response.',
    });
  });

  it("is 'none' on an empty result", async () => {
    fetchMock.mockResolvedValueOnce(page({ results: [] }));
    expect(await getFreshdeskContact('rv@example.test')).toEqual({ status: 'none' });
  });

  it.each([
    ['a 404', () => new Response('{}', { status: 404 }), /returned 404/],
    ['a 429', () => new Response('{}', { status: 429 }), /rate limit/],
  ])('is unavailable on %s', async (_label, response, reason) => {
    fetchMock.mockResolvedValueOnce(response());
    const out = await getFreshdeskContact('rv@example.test');
    expect(out.status === 'unavailable' && out.reason).toMatch(reason);
  });

  it('is unavailable without a key or an email, asking nothing', async () => {
    expect((await getFreshdeskContact(null)).status).toBe('unavailable');
    delete process.env.FRESHDESK_API_KEY;
    expect(await getFreshdeskContact('rv@example.test')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk is not configured.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is unavailable when the request throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await getFreshdeskContact('rv@example.test')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk did not respond.',
    });
  });
});
