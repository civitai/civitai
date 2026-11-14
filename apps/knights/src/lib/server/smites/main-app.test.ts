import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SMITES } from './config';
import { resetPlayerInMainApp } from './main-app';

const fetchMock = vi.fn<typeof fetch>();
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  process.env.WEBHOOK_TOKEN = 'secret';
  process.env.CIVITAI_APP_URL = 'https://main.example/';
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.CIVITAI_APP_URL;
});

describe('resetPlayerInMainApp', () => {
  it('posts the player to the reset endpoint with the shared token in a header', async () => {
    fetchMock.mockResolvedValue(answer({ playerId: 9, outcome: 'reset' }));
    await resetPlayerInMainApp(9);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://main.example/api/mod/knights/reset-player');
    expect(new Headers(init?.headers).get('x-webhook-token')).toBe('secret');
    expect(JSON.parse(String(init?.body))).toEqual({ playerId: 9, limit: SMITES.max });
  });

  it('counts an already reset player as done', async () => {
    fetchMock.mockResolvedValue(answer({ playerId: 9, outcome: 'not-due' }));
    await expect(resetPlayerInMainApp(9)).resolves.toBeUndefined();
  });

  it.each([
    ['a server error', () => answer({}, 500)],
    ['an answer it does not know', () => answer({ outcome: 'maybe' })],
    ['an unreadable answer', () => new Response('nope')],
  ])('throws on %s, so the reset is retried', async (_label, response) => {
    fetchMock.mockResolvedValue(response());
    await expect(resetPlayerInMainApp(9)).rejects.toThrow();
  });

  it('throws on a refused token or an unconfigured endpoint, so the reset is retried', async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: 'Unauthorized' }, 401));
    await expect(resetPlayerInMainApp(9)).rejects.toThrow(/401/);
    fetchMock.mockResolvedValueOnce(answer({ error: 'Endpoint not configured' }, 503));
    await expect(resetPlayerInMainApp(9)).rejects.toThrow(/503/);
  });

  it.each(['', '   '])('treats a blank token (%j) as not configured', async (blank) => {
    process.env.WEBHOOK_TOKEN = blank;
    await expect(resetPlayerInMainApp(9)).rejects.toThrow(/WEBHOOK_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when the token is not configured', async () => {
    delete process.env.WEBHOOK_TOKEN;
    await expect(resetPlayerInMainApp(9)).rejects.toThrow(/WEBHOOK_TOKEN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
