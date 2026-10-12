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
const refused = (status: number, body: object) => new Response(JSON.stringify(body), { status });

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
    expect(fetchMock.mock.calls[0][0]).toBe(`${APP_ASSISTANT_TOKEN_ROUTE}?for=chat`);

    now = NOW + 9.5 * 60_000; // inside the one-minute margin
    expect(await provider.getToken()).toBe('t2');
  });

  it('keeps the chat and sandbox tokens apart', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('chat', 3_600_000))
      .mockResolvedValueOnce(minted('sandbox', 3_600_000));
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    expect(await provider.getToken()).toBe('chat');
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('sandbox');
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('sandbox');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${APP_ASSISTANT_TOKEN_ROUTE}?for=chat`,
      `${APP_ASSISTANT_TOKEN_ROUTE}?for=sandbox`,
    ]);
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

  it('reports consent_required, and enable() turns the assistant on with a POST', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        refused(403, { error: 'Turn on App Assistant', code: 'consent_required' })
      )
      .mockResolvedValueOnce(minted('t1', 3_600_000));
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);

    await expect(provider.getToken()).rejects.toMatchObject({
      status: 403,
      code: 'consent_required',
    });
    expect(await provider.enable()).toBe('t1');
    expect(fetchMock.mock.calls[1]).toEqual([
      APP_ASSISTANT_TOKEN_ROUTE,
      expect.objectContaining({ method: 'POST' }),
    ]);
    expect(await provider.getToken()).toBe('t1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed mint instead of keeping the failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(minted('t1', 3_600_000));
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    await expect(provider.getToken()).rejects.toMatchObject({
      status: 503,
      message: 'Could not start an App Assistant session',
    });
    expect(await provider.getToken()).toBe('t1');
  });

  it('does not reuse a token whose expiry it cannot read', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ token: 't' }), { status: 200 })
      );
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    await provider.getToken();
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the route's refusal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(refused(403, { error: 'App Assistant is not available on this account' }));
    const provider = createAssistantTokenProvider(fetchMock, () => NOW);
    await expect(provider.getToken()).rejects.toEqual(
      new AssistantTokenError('App Assistant is not available on this account', 403)
    );
  });
});
