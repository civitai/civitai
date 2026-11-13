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
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => now });

    expect(await Promise.all([provider.getToken(), provider.getToken()])).toEqual(['t1', 't1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${APP_ASSISTANT_TOKEN_ROUTE}?for=chat`);

    now = NOW + 8.5 * 60_000; // 90s left: outside the one-minute margin, so reused
    expect(await provider.getToken()).toBe('t1');
    now = NOW + 9.5 * 60_000; // 30s left: inside it, so replaced
    expect(await provider.getToken()).toBe('t2');
  });

  it('keeps the chat and sandbox tokens apart', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('chat', 3_600_000))
      .mockResolvedValueOnce(minted('sandbox', 3_600_000));
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });
    expect(await provider.getToken()).toBe('chat');
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('sandbox');
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('sandbox');
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${APP_ASSISTANT_TOKEN_ROUTE}?for=chat`,
      `${APP_ASSISTANT_TOKEN_ROUTE}?for=sandbox`,
    ]);
  });

  it('runs a chat and a sandbox mint concurrently without sharing one request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      minted(String(url).endsWith('sandbox') ? 'sandbox' : 'chat', 3_600_000)
    );
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });
    expect(
      await Promise.all([provider.getToken(), provider.getToken({ purpose: 'sandbox' })])
    ).toEqual(['chat', 'sandbox']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forgets a token whose refresh was refused, so it is never handed out again', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('t1', 3_600_000))
      .mockResolvedValueOnce(
        refused(403, { error: 'Turn on App Assistant', code: 'consent_required' })
      )
      .mockResolvedValueOnce(
        refused(403, { error: 'Turn on App Assistant', code: 'consent_required' })
      );
    const onConsentRequired = vi.fn();
    const provider = createAssistantTokenProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      onConsentRequired,
    });
    await provider.getToken();
    await expect(provider.getToken({ refresh: true })).rejects.toMatchObject({
      code: 'consent_required',
    });
    await expect(provider.getToken()).rejects.toMatchObject({ code: 'consent_required' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onConsentRequired).toHaveBeenCalledTimes(2);
  });

  it('mints a new one on refresh', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('t1', 3_600_000))
      .mockResolvedValueOnce(minted('t2', 3_600_000));
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });
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
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });

    await expect(provider.getToken()).rejects.toMatchObject({
      status: 403,
      code: 'consent_required',
    });
    expect(await provider.enable()).toBe('t1');
    expect(fetchMock.mock.calls[1]).toEqual([
      APP_ASSISTANT_TOKEN_ROUTE,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(await provider.getToken()).toBe('t1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a callback that asks for a token again joins the refused request instead of looping', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      refused(403, { error: 'Turn on App Assistant', code: 'consent_required' })
    );
    let reentered: Promise<string> | undefined;
    const provider = createAssistantTokenProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      onConsentRequired: () => {
        reentered ??= provider.getToken({ refresh: true });
      },
    });
    await expect(provider.getToken()).rejects.toMatchObject({ code: 'consent_required' });
    await expect(reentered).rejects.toMatchObject({ code: 'consent_required' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enable() drops tokens minted before it, which a revoke deleted', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(minted('old-sandbox', 3_600_000))
      .mockResolvedValueOnce(minted('chat', 3_600_000))
      .mockResolvedValueOnce(minted('new-sandbox', 3_600_000));
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('old-sandbox');
    await provider.enable();
    expect(await provider.getToken({ purpose: 'sandbox' })).toBe('new-sandbox');
  });

  it('retries after a failed mint instead of keeping the failure', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(minted('t1', 3_600_000));
    const onConsentRequired = vi.fn();
    const provider = createAssistantTokenProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      onConsentRequired,
    });
    await expect(provider.getToken()).rejects.toMatchObject({
      status: 503,
      message: 'Could not start an App Assistant session',
    });
    expect(await provider.getToken()).toBe('t1');
    expect(onConsentRequired).not.toHaveBeenCalled();
  });

  it('does not reuse a token whose expiry it cannot read', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(JSON.stringify({ token: 't' }), { status: 200 })
      );
    const provider = createAssistantTokenProvider({ fetchImpl: fetchMock, now: () => NOW });
    await provider.getToken();
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the route's refusal", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(refused(403, { error: 'App Assistant is not available on this account' }));
    const onConsentRequired = vi.fn();
    const provider = createAssistantTokenProvider({
      fetchImpl: fetchMock,
      now: () => NOW,
      onConsentRequired,
    });
    await expect(provider.getToken()).rejects.toEqual(
      new AssistantTokenError('App Assistant is not available on this account', 403)
    );
    // A banned or unflagged account is not a revoke.
    expect(onConsentRequired).not.toHaveBeenCalled();
  });
});
