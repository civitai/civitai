import { describe, expect, it, vi } from 'vitest';
import {
  APP_ASSISTANT_TOKEN_ROUTE,
  AssistantTokenError,
  createAssistantTokenProvider,
} from '~/components/Apps/AppAssistant/assistantToken';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const minted = (token: string, expiresInMs: number) =>
  new Response(JSON.stringify({ token, expiresAt: new Date(NOW + expiresInMs).toISOString() }), {
    status: 200,
  });

describe('createAssistantTokenProvider', () => {
  it('reuses a token until shortly before it expires, and shares one in-flight request', async () => {
    let now = NOW;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('t1', 10 * 60_000))
      .mockResolvedValueOnce(minted('t2', 10 * 60_000));
    const provider = createAssistantTokenProvider(fetchMock, () => now);

    expect(await Promise.all([provider.getToken(), provider.getToken()])).toEqual(['t1', 't1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(APP_ASSISTANT_TOKEN_ROUTE);

    now = NOW + 9.5 * 60_000; // inside the one-minute margin
    expect(await provider.getToken()).toBe('t2');
  });

  it('mints a new one on refresh', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('t1', 3_600_000))
      .mockResolvedValueOnce(minted('t2', 3_600_000));
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    await provider.getToken();
    expect(await provider.getToken({ refresh: true })).toBe('t2');
  });

  it("surfaces the route's refusal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'App Assistant is not available on this account' }), {
        status: 403,
      })
    );
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    await expect(provider.getToken()).rejects.toEqual(
      new AssistantTokenError('App Assistant is not available on this account', 403)
    );
  });
});
