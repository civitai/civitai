import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPrivateNote, replyToTicket, setTicketStatus } from '../freshdesk-write.service';

/** Every call against a stubbed `fetch` — no Freshdesk request is made. */

const saved = { key: process.env.FRESHDESK_WRITE_API_KEY, domain: process.env.FRESHDESK_DOMAIN };
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
};

beforeEach(() => {
  process.env.FRESHDESK_WRITE_API_KEY = 'write-key';
  process.env.FRESHDESK_DOMAIN = 'help.example.test';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of [
    ['FRESHDESK_WRITE_API_KEY', saved.key],
    ['FRESHDESK_DOMAIN', saved.domain],
  ] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

describe('freshdesk write calls', () => {
  it('replies with POST /tickets/{id}/reply and the html body, authenticated with the write key', async () => {
    fetchMock.mockResolvedValue(json({ id: 1 }, { status: 201 }));
    expect(await replyToTicket('74924', '<p>Hi</p>')).toEqual({ status: 'ok' });
    const { url, init, body } = sent();
    expect(url).toBe('https://help.example.test/api/v2/tickets/74924/reply');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ body: '<p>Hi</p>' });
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from('write-key:X').toString('base64')}`
    );
  });

  it('adds a PRIVATE note with POST /tickets/{id}/notes', async () => {
    fetchMock.mockResolvedValue(json({ id: 2 }, { status: 201 }));
    expect(await addPrivateNote('74924', 'Sent by a')).toEqual({ status: 'ok' });
    const { url, init, body } = sent();
    expect(url).toBe('https://help.example.test/api/v2/tickets/74924/notes');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ body: 'Sent by a', private: true });
  });

  it('sets the status with PUT /tickets/{id}', async () => {
    fetchMock.mockResolvedValue(json({ id: 74924, status: 4 }));
    expect(await setTicketStatus('74924', 4)).toEqual({ status: 'ok' });
    const { url, init, body } = sent();
    expect(url).toBe('https://help.example.test/api/v2/tickets/74924');
    expect(init.method).toBe('PUT');
    expect(body).toEqual({ status: 4 });
  });

  it('is not_configured without the write key, and never falls back to the read key', async () => {
    delete process.env.FRESHDESK_WRITE_API_KEY;
    process.env.FRESHDESK_API_KEY = 'read-key';
    expect(await replyToTicket('1', '<p>x</p>')).toEqual({ status: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.FRESHDESK_API_KEY;
  });

  it('refuses an id that is not a Freshdesk id without calling out', async () => {
    const res = await replyToTicket('../agents', '<p>x</p>');
    expect(res.status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 429 to a retry hint', async () => {
    fetchMock.mockResolvedValue(
      new Response('', { status: 429, headers: { 'retry-after': '37' } })
    );
    const res = await replyToTicket('1', '<p>x</p>');
    expect(res).toMatchObject({ status: 'error', httpStatus: 429, certain: true });
    expect((res as { message: string }).message).toMatch(/rate limit.*retry in 37s/i);
  });

  it('maps an API refusal to its status and Freshdesk description', async () => {
    fetchMock.mockResolvedValue(json({ description: 'Validation failed' }, { status: 400 }));
    expect(await setTicketStatus('1', 3)).toEqual({
      status: 'error',
      httpStatus: 400,
      certain: true,
      message: 'Freshdesk refused it (400): Validation failed',
    });
  });

  it('treats a 5xx and a 408 as uncertain, not as a refusal', async () => {
    for (const status of [500, 503, 408]) {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      expect(await replyToTicket('1', '<p>x</p>')).toMatchObject({
        httpStatus: status,
        certain: false,
      });
    }
  });

  it('maps a network failure to an error rather than throwing', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));
    expect(await addPrivateNote('1', 'n')).toMatchObject({
      status: 'error',
      httpStatus: null,
      certain: false,
    });
  });
});
