import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envMock } from '~/__tests__/mocks/env.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import '~/__tests__/mocks/logging.mock';
import type * as Service from '~/server/services/feature-pages.service';

const HUB = 'https://hub.test';
const SIGNER = 'http://signer.internal';
const REQUEST = 'urn:data.civitai.com:feature-pages/requests/dark-mode';

let service: typeof Service;
let fetchMock: ReturnType<typeof vi.fn>;
let minted: number;
let signerReplies: Array<(token: string) => Response>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  vi.stubEnv('AUTH_JWT_ISSUER', HUB);
  envMock.set({
    FEATURE_PAGES_SIGNER_URL: SIGNER,
    FEATURE_PAGES_CLIENT_ID: 'client-id',
    FEATURE_PAGES_CLIENT_SECRET: 'client-secret',
  });
  installFakeCacheRedis();
  minted = 0;
  signerReplies = [];
  fetchMock = vi.fn(async (input: string, init: RequestInit) => {
    if (input === `${HUB}/api/auth/oauth/token`) {
      minted += 1;
      return json(200, { access_token: `token-${minted}`, expires_in: 900 });
    }
    if (input.startsWith(SIGNER)) {
      const token = String(new Headers(init.headers).get('authorization')).replace('Bearer ', '');
      const reply = signerReplies.shift();
      if (!reply) throw new Error('unexpected signer call');
      return reply(token);
    }
    throw new Error(`unexpected fetch ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  service = await import('~/server/services/feature-pages.service');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const signerCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith(SIGNER)) as Array<
    [string, RequestInit]
  >;

describe('resolveFeaturePageEmbed', () => {
  const feature = 'urn:data.civitai.com:feature-pages/features/dark-mode';

  it.each([
    'https://features.civitai.com/feature.html',
    'https://civitai.com/feature.html',
    'https://x.civitai.red/feature.html',
    'https://pr-1.civitaic.com/feature.html',
    'https://features.civitai.com./feature.html',
    'http://features.example.com/feature.html',
    'not a url',
  ])('refuses %s', (url) => {
    expect(service.resolveFeaturePageEmbed(url, feature)).toBeNull();
  });

  it('frames a page on another registrable domain, naming the feature', () => {
    expect(
      service.resolveFeaturePageEmbed('https://features.example.com/feature.html', feature)
    ).toEqual({
      src: `https://features.example.com/feature.html?feature=${encodeURIComponent(feature)}`,
      origin: 'https://features.example.com',
    });
    expect(
      service.resolveFeaturePageEmbed('http://127.0.0.1:7560/feature.html', feature)?.origin
    ).toBe('http://127.0.0.1:7560');
  });
});

describe('castFeaturePageVote', () => {
  it('signs the vote as the signed-in user with the service token, and returns the tally', async () => {
    signerReplies.push(() => json(200, { votes: 7 }));

    await expect(service.castFeaturePageVote(42, { request: REQUEST, value: 1 })).resolves.toEqual({
      votes: 7,
    });

    const [[url, init]] = signerCalls();
    expect(url).toBe(`${SIGNER}/internal/vote`);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-1');
    expect(JSON.parse(String(init.body))).toMatchObject({ uid: 42, request: REQUEST, value: 1 });
  });

  it('reuses the cached service token across votes', async () => {
    signerReplies.push(
      () => json(200, { votes: 1 }),
      () => json(200, { votes: 2 })
    );
    await service.castFeaturePageVote(1, { request: REQUEST, value: 1 });
    await service.castFeaturePageVote(2, { request: REQUEST, value: 1 });
    expect(minted).toBe(1);
  });

  it('mints a fresh token once when the signer rejects the cached one', async () => {
    signerReplies.push(
      (token) => json(token === 'token-1' ? 401 : 200, {}),
      (token) => json(token === 'token-2' ? 200 : 401, { votes: 3 })
    );

    await expect(service.castFeaturePageVote(42, { request: REQUEST, value: 0 })).resolves.toEqual({
      votes: 3,
    });
    expect(minted).toBe(2);

    // The fresh token replaces the rejected one in the cache.
    signerReplies.push((token) => json(token === 'token-2' ? 200 : 401, { votes: 4 }));
    await service.castFeaturePageVote(43, { request: REQUEST, value: 1 });
    expect(minted).toBe(2);
  });

  it('answers try-again, not refused, when the fresh token is rejected too', async () => {
    signerReplies.push(
      () => json(401, {}),
      () => json(401, {})
    );
    await expect(
      service.castFeaturePageVote(42, { request: REQUEST, value: 1 })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    expect(minted).toBe(2);
  });

  it.each([
    [
      'unreachable',
      'INTERNAL_SERVER_ERROR',
      () => Promise.reject(new DOMException('', 'TimeoutError')),
    ],
    ['500', 'INTERNAL_SERVER_ERROR', () => json(500, {})],
    ['a reply without a tally', 'INTERNAL_SERVER_ERROR', () => json(200, { votes: 'x' })],
    ['429', 'TOO_MANY_REQUESTS', () => json(429, { code: 'rate_limited' })],
    ['403', 'FORBIDDEN', () => json(403, { code: 'no_grant' })],
    // A route the platform does not have is a deploy gap, retried; a record it does not know is final.
    ['404 for a missing route', 'INTERNAL_SERVER_ERROR', () => json(404, { code: 'not_found' })],
    ['404 with no body', 'INTERNAL_SERVER_ERROR', () => new Response('', { status: 404 })],
    ['404 unknown_subject', 'FORBIDDEN', () => json(404, { code: 'unknown_subject' })],
  ])('maps a signer answering %s to %s', async (_, code, reply) => {
    signerReplies.push(reply as () => Response);
    await expect(
      service.castFeaturePageVote(42, { request: REQUEST, value: 1 })
    ).rejects.toMatchObject({ code });
  });

  it('refuses without calling anything when the signer is not configured', async () => {
    envMock.set({ FEATURE_PAGES_CLIENT_SECRET: undefined });
    await expect(
      service.castFeaturePageVote(42, { request: REQUEST, value: 1 })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('getMyFeaturePageVotes', () => {
  it("reads the signed-in user's own votes for the requests asked", async () => {
    signerReplies.push(() => json(200, { votes: { [REQUEST]: 1 } }));

    await expect(service.getMyFeaturePageVotes(42, { requests: [REQUEST] })).resolves.toEqual({
      votes: { [REQUEST]: 1 },
    });

    const [[url, init]] = signerCalls();
    expect(url).toBe(`${SIGNER}/internal/mine`);
    expect(JSON.parse(String(init.body))).toEqual({ uid: 42, requests: [REQUEST] });
  });
});

describe('getFeaturePageViewerHandle', () => {
  const author = `h1:${'b'.repeat(64)}`;

  it('asks the platform for the uid once, then serves the handle from cache', async () => {
    signerReplies.push(() => json(200, { author }));

    await expect(service.getFeaturePageViewerHandle(42)).resolves.toBe(author);
    await expect(service.getFeaturePageViewerHandle(42)).resolves.toBe(author);

    const calls = signerCalls();
    expect(calls.map(([url]) => url)).toEqual([`${SIGNER}/internal/handle?uid=42`]);
  });

  it.each([
    ['a refusal', () => json(400, { code: 'bad_request' })],
    ['a reply that is not a handle', () => json(200, { author: 'u42' })],
  ])('gives no handle on %s, and asks again next time', async (_, reply) => {
    signerReplies.push(reply, () => json(200, { author }));

    await expect(service.getFeaturePageViewerHandle(42)).resolves.toBeNull();
    await expect(service.getFeaturePageViewerHandle(42)).resolves.toBe(author);
  });
});
