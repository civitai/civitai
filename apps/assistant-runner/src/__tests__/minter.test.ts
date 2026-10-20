import { describe, expect, it } from 'vitest';

import { RunCredentials } from '../credentials';
import { withRequestGrant } from '../grants';
import { MintRefusedError, TokenMinter, type TokenPurpose } from '../minter';

const SECRET = 'test-only-runner-secret';

/** A stand-in for civitai's mint endpoint: records what it was sent, answers what it is told to. */
function fakeCivitai(answer: (body: { grant: string; purpose: TokenPurpose }) => Response) {
  const calls: {
    url: string;
    authorization: string | null;
    body: { grant: string; purpose: TokenPurpose };
  }[] = [];
  const doFetch: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { grant: string; purpose: TokenPurpose };
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      body,
    });
    return answer(body);
  };
  return { calls, doFetch };
}

const minted = (token: string, inMs: number, now: number) =>
  Response.json({ token, expiresAt: new Date(now + inMs).toISOString() });

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe('TokenMinter', () => {
  it('trades the grant with the runner secret, and keeps the token until shortly before it expires', async () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    let n = 0;
    const civitai = fakeCivitai((body) => minted(`${body.purpose}-token-${++n}`, 5 * 60_000, now));
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: civitai.doFetch,
      now: () => now,
    });

    expect(await minter.token('grant-a', 'chat')).toBe('chat-token-1');
    expect(civitai.calls[0]).toEqual({
      url: 'https://civitai.example/api/internal/app-assistant/runner-token',
      authorization: `Bearer ${SECRET}`,
      body: { grant: 'grant-a', purpose: 'chat' },
    });
    now += 3 * 60_000;
    expect(await minter.token('grant-a', 'chat')).toBe('chat-token-1');
    expect(await minter.token('grant-a', 'sandbox')).toBe('sandbox-token-2');
    expect(await minter.token('grant-b', 'chat')).toBe('chat-token-3');
    // Within a minute of expiry: minted again.
    now += 90_000;
    expect(await minter.token('grant-a', 'chat')).toBe('chat-token-4');
    // A fresh one on request (after a 401), whatever the cache holds.
    expect(await minter.token('grant-a', 'chat', { fresh: true })).toBe('chat-token-5');
    expect(civitai.calls).toHaveLength(5);
  });

  it('shares one mint between concurrent callers', async () => {
    const civitai = fakeCivitai(() => minted('t', 300_000, Date.now()));
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      log: quiet,
      fetch: civitai.doFetch,
    });
    await Promise.all([
      minter.token('g', 'chat'),
      minter.token('g', 'chat'),
      minter.token('g', 'chat'),
    ]);
    expect(civitai.calls).toHaveLength(1);
  });

  it('says consent is gone when civitai refuses for that, and keeps nothing', async () => {
    let refuse = true;
    const civitai = fakeCivitai(() =>
      refuse
        ? Response.json(
            { error: 'Turn on App Assistant to continue', code: 'consent_required' },
            { status: 403 }
          )
        : minted('t', 300_000, Date.now())
    );
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      log: quiet,
      fetch: civitai.doFetch,
    });
    const error = await minter.token('g', 'chat').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MintRefusedError);
    expect(error).toMatchObject({ code: 'consent_required', status: 403 });
    refuse = false;
    expect(await minter.token('g', 'chat')).toBe('t');
    expect(civitai.calls).toHaveLength(2);
  });

  it('reads a refused grant or secret as invalid, and anything else as unavailable', async () => {
    for (const [status, code] of [
      [401, 'invalid_grant'],
      [503, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      const civitai = fakeCivitai(() => Response.json({ error: 'no' }, { status }));
      const minter = new TokenMinter({
        civitaiUrl: 'https://civitai.example',
        secret: SECRET,
        log: quiet,
        fetch: civitai.doFetch,
      });
      await expect(minter.token('g', 'chat'), `${status}`).rejects.toMatchObject({ code });
    }
  });
});

describe('RunCredentials', () => {
  const minter = { token: async (grant: string, purpose: TokenPurpose) => `${purpose}:${grant}` };
  const rows = {
    forRun: async (runId: string) => (runId === 'r1' ? 'grant-of-r1' : null),
    forConversation: async (userId: string, conversationId: string) =>
      userId === 'u1' && conversationId === 'c1' ? 'grant-of-c1' : null,
  };
  const credentials = new RunCredentials(rows, minter);

  it('mints a run’s model tokens from that run’s grant', async () => {
    expect(await credentials.forRun('r1')('chat')).toBe('chat:grant-of-r1');
    await expect(credentials.forRun('r2')('chat')).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('mints a conversation’s tokens from the request’s own grant first, else a live run’s', async () => {
    expect(await credentials.forConversation('u1', 'c1')('chat')).toBe('chat:grant-of-c1');
    const own = { userId: 'u1', conversationId: 'c9', token: 'grant-from-request' };
    expect(await withRequestGrant(own, () => credentials.forConversation('u1', 'c9')('chat'))).toBe(
      'chat:grant-from-request'
    );
    // A request's grant is for its own user and chat only.
    await expect(
      withRequestGrant(own, () => credentials.forConversation('u2', 'c9')('chat'))
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await withRequestGrant(own, () => credentials.forConversation('u1', 'c1')('chat'))).toBe(
      'chat:grant-of-c1'
    );
  });
});
