import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_TIMEOUT_MS,
  getTicketDescription,
} from '../freshdesk.service';
import { HTML_MAX_CHARS } from '../html-to-text';

/**
 * The formatted ticket body behind `/decisions/support/ticket/[id]`, against a stubbed `fetch` — no
 * Freshdesk call is made. What it must never do: report "could not ask" as a found body, or throw.
 */

const saved = { key: process.env.FRESHDESK_API_KEY, domain: process.env.FRESHDESK_DOMAIN };
let fetchMock: ReturnType<typeof vi.fn>;

const ticket = (body: unknown, init: ResponseInit = {}) =>
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
  vi.restoreAllMocks();
  for (const [k, v] of [
    ['FRESHDESK_API_KEY', saved.key],
    ['FRESHDESK_DOMAIN', saved.domain],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe('getTicketDescription', () => {
  it('returns the HTML description as formatted text', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({
        description:
          '<div>Hi team,</div><div><br></div><ul><li>point one</li><li>point two</li></ul>',
        description_text: 'Hi team, point one point two',
      })
    );
    expect(await getTicketDescription('40017')).toEqual({
      status: 'found',
      text: 'Hi team,\n\n• point one\n• point two',
      truncated: false,
    });
  });

  it('reads ONE ticket from the configured host, with the key as basic auth and the short timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValueOnce(ticket({ description: '<p>x</p>' }));
    await getTicketDescription('40017');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://help.example.test/api/v2/tickets/40017');
    expect((init as RequestInit).headers).toEqual({
      authorization: `Basic ${Buffer.from('test-key:X').toString('base64')}`,
    });
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
    expect(timeout).toHaveBeenCalledWith(DESCRIPTION_TIMEOUT_MS);
    expect(DESCRIPTION_TIMEOUT_MS).toBeLessThan(8000);
  });

  it('caps a long body and says so', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ description: `<p>${'a'.repeat(DESCRIPTION_MAX_CHARS + 50)}</p>` })
    );
    const out = await getTicketDescription('40017');
    expect(out.status).toBe('found');
    if (out.status !== 'found') return;
    expect(out.text).toHaveLength(DESCRIPTION_MAX_CHARS);
    expect(out.truncated).toBe(true);
  });

  it('a 404 is "unavailable" naming the ticket, never "found"', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect(await getTicketDescription('40017')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk has no ticket 40017 — it may have been deleted or merged.',
    });
  });

  it('a 429 is "unavailable" and says it is the rate limit', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'retry-after': '37' } })
    );
    expect(await getTicketDescription('40017')).toEqual({
      status: 'unavailable',
      reason: "Freshdesk's rate limit is reached — try again in 37s.",
    });
  });

  it('a timeout is "unavailable", not a throw', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    expect(await getTicketDescription('40017')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk did not respond.',
    });
  });

  it('an unexpected body is "unavailable"', async () => {
    fetchMock.mockResolvedValueOnce(ticket([{ description: '<p>x</p>' }]));
    expect((await getTicketDescription('40017')).status).toBe('unavailable');
  });

  it('a message cut by the input cap is never reported as "no description"', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ description: `<head><style>${'x'.repeat(HTML_MAX_CHARS)}</style></head><p>hi</p>` })
    );
    expect(await getTicketDescription('40017')).toEqual({
      status: 'unavailable',
      reason: "Freshdesk's formatted copy could not be read in full; open it in Freshdesk.",
    });
  });

  it('a message emptied by the OUTPUT cap is not "no description" either', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ description: `<pre>${'\n'.repeat(60_000)}</pre><p>the real message</p>` })
    );
    expect((await getTicketDescription('40017')).status).toBe('unavailable');
  });

  it('text cut by the output cap is marked truncated even under DESCRIPTION_MAX_CHARS', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ description: `<p>Hi</p><pre>${'\n'.repeat(60_000)}</pre><p>more</p>` })
    );
    const out = await getTicketDescription('40017');
    expect(out).toMatchObject({ status: 'found', truncated: true });
  });

  it('text that survives the input cap is marked truncated', async () => {
    fetchMock.mockResolvedValueOnce(
      ticket({ description: `<p>hello</p><img src="data:,${'A'.repeat(HTML_MAX_CHARS)}">` })
    );
    expect(await getTicketDescription('40017')).toEqual({
      status: 'found',
      text: 'hello',
      truncated: true,
    });
  });

  it('an empty description is "none"', async () => {
    fetchMock.mockResolvedValueOnce(ticket({ description: '<div><br></div>' }));
    expect(await getTicketDescription('40017')).toEqual({ status: 'none' });
  });

  it('asks nothing without a key, or for an id that is not a Freshdesk id', async () => {
    expect((await getTicketDescription('40017/../contacts')).status).toBe('unavailable');
    delete process.env.FRESHDESK_API_KEY;
    expect(await getTicketDescription('40017')).toEqual({
      status: 'unavailable',
      reason: 'Freshdesk is not configured.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
