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
  it('trades the grant with the runner secret, and uses one token for a minute at most', async () => {
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
    now += 30_000;
    expect(await minter.token('grant-a', 'chat')).toBe('chat-token-1');
    expect(await minter.token('grant-b', 'chat')).toBe('chat-token-2');
    // Valid for minutes more, but a minute old: minted again, so civitai's gates (the runner's flag
    // among them) are asked again at least that often.
    now += 40_000;
    expect(await minter.token('grant-a', 'chat')).toBe('chat-token-3');
    // A fresh one on request (after a 401), whatever the cache holds.
    expect(await minter.token('grant-a', 'chat', { fresh: true })).toBe('chat-token-4');
    expect(civitai.calls).toHaveLength(4);
  });

  it('mints again a minute before expiry, for a token valid less than two minutes', async () => {
    let now = Date.parse('2026-10-20T12:00:00Z');
    let n = 0;
    const civitai = fakeCivitai(() => minted(`t-${++n}`, 90_000, now));
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example/',
      secret: SECRET,
      log: quiet,
      fetch: civitai.doFetch,
      now: () => now,
    });
    expect(await minter.token('g', 'sandbox')).toBe('t-1');
    now += 20_000;
    expect(await minter.token('g', 'sandbox')).toBe('t-1');
    now += 15_000;
    expect(await minter.token('g', 'sandbox')).toBe('t-2');
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

  it('tells a refused grant from a refused runner, a refused user and an outage', async () => {
    for (const [answer, code] of [
      [() => Response.json({ code: 'invalid_grant' }, { status: 401 }), 'invalid_grant'],
      // No code: civitai refused the runner's secret, a deployment fault.
      [() => Response.json({ error: 'Unauthorized' }, { status: 401 }), 'unavailable'],
      [() => Response.json({ error: 'no' }, { status: 403 }), 'unavailable'],
      [() => Response.json({ code: 'refused', error: 'banned' }, { status: 403 }), 'refused'],
      [() => Response.json({ error: 'no' }, { status: 503 }), 'unavailable'],
      [() => new Response('<html>', { status: 500 }), 'unavailable'],
    ] as const) {
      const civitai = fakeCivitai(answer);
      const minter = new TokenMinter({
        civitaiUrl: 'https://civitai.example',
        secret: SECRET,
        log: quiet,
        fetch: civitai.doFetch,
      });
      await expect(minter.token('g', 'chat'), code).rejects.toMatchObject({ code });
    }
  });
});

describe('TokenMinter refusals and stops', () => {
  it('reads a gate refusal as refused, with civitai’s reason, and never as the runner’s secret', async () => {
    const errors: string[] = [];
    const civitai = fakeCivitai(() =>
      Response.json(
        {
          error: 'You cannot perform this action because your account has been banned',
          code: 'refused',
        },
        { status: 403 }
      )
    );
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      log: { ...quiet, error: (_o, message) => errors.push(String(message)) },
      fetch: civitai.doFetch,
    });
    await expect(minter.token('g', 'chat')).rejects.toMatchObject({
      code: 'refused',
      status: 403,
      message: expect.stringMatching(/banned/),
    });
    expect(errors).toEqual([]);
  });

  it('stops waiting for a mint as soon as the run stops, without waiting out the mint', async () => {
    let answer: (response: Response) => void = () => undefined;
    const civitai = fakeCivitai(() => new Response('', { status: 500 }));
    const slow: typeof fetch = (input, init) =>
      new Promise((resolve) => {
        answer = resolve;
        void civitai.doFetch(input, init);
      });
    const minter = new TokenMinter({
      civitaiUrl: 'https://civitai.example',
      secret: SECRET,
      log: quiet,
      fetch: slow,
    });
    const stop = new AbortController();
    const waiting = minter.token('g', 'chat', { signal: stop.signal });
    stop.abort(new Error('stopped'));
    // Bounded: a minter that ignores the stop reads as still waiting after 2 s, not as a hang.
    const outcome = await Promise.race([
      waiting.then(
        () => 'minted',
        (error: Error) => error.message
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
    ]);
    expect(outcome).toBe('stopped');
    answer(minted('late', 300_000, Date.now()));
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
