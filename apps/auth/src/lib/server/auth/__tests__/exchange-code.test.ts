import { describe, it, expect, vi, afterEach } from 'vitest';
import { exchangeCode, getProvider } from '../providers';

afterEach(() => vi.unstubAllGlobals());

async function sentBody(codeVerifier?: string) {
  process.env.DISCORD_CLIENT_ID = 'client-123';
  process.env.DISCORD_CLIENT_SECRET = 'secret';
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ access_token: 'at', scope: 'identify' }))
  );
  vi.stubGlobal('fetch', fetchMock);
  await exchangeCode(getProvider('discord')!, {
    code: 'c-1',
    redirectUri: 'https://auth.civitai.com/login/discord/callback',
    codeVerifier,
  });
  const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
  return init.body as URLSearchParams;
}

describe('exchangeCode', () => {
  it('sends the PKCE verifier when the flow has one', async () => {
    const body = await sentBody('ver-1');
    expect(body.get('code_verifier')).toBe('ver-1');
    expect(body.get('client_secret')).toBe('secret');
  });

  it('sends no code_verifier on a no-PKCE leg, still authenticating with the client secret', async () => {
    const body = await sentBody(undefined);
    expect(body.has('code_verifier')).toBe(false);
    expect(body.get('code')).toBe('c-1');
    expect(body.get('client_secret')).toBe('secret');
  });
});
