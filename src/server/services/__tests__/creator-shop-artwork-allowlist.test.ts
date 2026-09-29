import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `validateArtwork` URL allowlist (creator-shop.service) — the SHARPEST of the four funnels.
 *
 * It is the only one that fetches from the NEXT.JS WEB POD rather than via the orchestrator,
 * and everything it derives from the response — a sha256 of the body, width, height, format,
 * frame count — is returned to the submitter. Ungated that is a RESPONSE ORACLE over any URL
 * the web pod can reach, on `creatorShopProcedure` (protectedProcedure + the `creatorShop`
 * flag): an ordinary signed-in user, not a moderator.
 *
 * 🔴 The assertion that matters is NOT merely "it throws". The pre-existing try/catch around
 * the fetch converts every failure into 'Could not read the uploaded artwork for validation',
 * so a guard placed INSIDE it would still make the call throw — and a test asserting only
 * `rejects` would pass while proving nothing about the allowlist. Both halves are pinned
 * separately below: the specific refusal message, AND that `fetch` was never called.
 */

const { mockFetch, mockSharp } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockSharp: vi.fn(),
}));

vi.mock('sharp', () => ({ default: mockSharp }));
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent: vi.fn() }));
vi.mock('~/server/redis/caches', () => ({ refreshOwnedStickerCache: vi.fn() }));
vi.mock('~/server/services/cosmetic-phash.service', () => ({
  queueCosmeticPerceptualHash: vi.fn(),
}));
vi.mock('~/server/services/placement-moderation.service', () => ({
  removePlacementsByCosmetic: vi.fn(),
}));
// NOTE: `@civitai/buzz` is deliberately NOT mocked. A thin `{}` stub made the suite fail to
// IMPORT (`No "clientToApiAccountType" export is defined`), which vitest reports as
// "Tests no tests" — a reassuring zero rather than a failure. The real module loads fine.
// Pin the edge host — @prisma/client dotenv-loads `<repo>/.env` at import.
vi.mock('~/env/client', () => ({
  env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' },
}));

import { submitCreatorShopItem } from '~/server/services/creator-shop.service';

const EVIL_URL = 'https://evil.com/oracle-target.png';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  // 🔴 A DEFAULT that WOULD succeed, so a missing guard cannot be mistaken for a pass: with
  // no default, `fetch` returns undefined and the call dies on `res.ok` inside the catch,
  // surfacing the SAME generic message the guard produces. Resolving here means an ungated
  // build gets past the fetch and fails a LATER, differently-worded assertion.
  mockFetch.mockResolvedValue({
    ok: true,
    // `headers.get` is read for the Content-Length pre-check. A mock without it throws a
    // TypeError INSIDE the try/catch, which surfaces as the generic read failure — i.e. the
    // suite would go green for the wrong reason on a deleted size cap.
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  mockSharp.mockReturnValue({
    metadata: async () => ({ width: 200, height: 200, format: 'png', hasAlpha: true, pages: 1 }),
  });
});

/**
 * A submit that clears every check PRECEDING the artwork guard — blocked-content, the rights
 * affirmation and the per-type price floors — so the guard is the thing under test rather
 * than the thing never reached. `price` is deliberately far above any floor.
 */
const submit = (imageUrl: string) =>
  submitCreatorShopItem({
    userId: 7,
    name: 'test badge',
    description: 'test',
    imageUrl,
    cosmeticType: 'Badge',
    animated: false,
    price: 1_000_000,
    sellableByOthers: false,
    rightsAffirmed: true,
  } as never);

describe('validateArtwork URL allowlist (web-pod fetch + response oracle)', () => {
  it('refuses an off-allowlist absolute URL with the allowlist message, not the generic one', async () => {
    const err = await submit(EVIL_URL).then(
      () => null,
      (e: unknown) => e
    );
    const message = err instanceof Error ? err.message : String(err ?? '');

    expect(message).toContain('Artwork must be an image uploaded to Civitai');
    // 🔴 The half that proves the guard sits OUTSIDE the try/catch. If it were inside, this
    // would read 'Could not read the uploaded artwork for validation' instead.
    expect(message).not.toContain('Could not read the uploaded artwork');
  });

  it('never opens the fetch — no request is made to the attacker-chosen host', async () => {
    await submit(EVIL_URL).catch(() => undefined);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('computes no hash and no sharp metadata, so nothing leaks back to the submitter', async () => {
    await submit(EVIL_URL).catch(() => undefined);
    // The oracle is the DERIVED data, so pin that it was never derived.
    expect(mockSharp).not.toHaveBeenCalled();
  });

  it('refuses the slash-light spelling getEdgeUrl would forward as a relative key', async () => {
    await submit('http:/169.254.169.254/latest/meta-data/').catch(() => undefined);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a private-host absolute URL reachable from the web pod', async () => {
    await submit('http://127.0.0.1:6379/').catch(() => undefined);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  /**
   * 🔴 DELIBERATE BEHAVIOUR CHANGE — this row previously asserted the OPPOSITE.
   *
   * Until now `validateArtwork` shared the INGESTION allowlist, so an absolute url on an
   * allowlisted host was fetched. That allowlist admits hosts an attacker can put bytes on
   * (`<any-bucket>.s3.wasabisys.com` is a self-service global namespace; `*.civitai.com` is
   * admitted on any port and path), which is tolerable for ingestion — it has a legacy
   * `Image.url` population — and wrong here, where every client call site sends a Cloudflare
   * upload id and the error string always claimed the narrower rule.
   */
  it.each([
    ['http:/image.civitai.com/a/b.png', 'an allowlisted civitai host, slash-light'],
    ['https://image.civitai.com/a/b.png', 'an allowlisted civitai host'],
    ['https://attacker-bucket.s3.wasabisys.com/evil.png', 'an attacker-registrable wasabi bucket'],
    [
      'https://lh3.googleusercontent.com/a/AAcHTtf=s96-c',
      'an avatar host the ingestion list allows',
    ],
  ])('now REFUSES %s (%s) — absolute urls are no longer artwork', async (url) => {
    const err = await submit(url).then(
      () => null,
      (e: unknown) => e
    );
    expect(err instanceof Error ? err.message : String(err)).toContain(
      'Artwork must be an image uploaded to Civitai'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fetches an allowed relative storage key, resolved onto the edge', async () => {
    await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').catch(() => undefined);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0]).startsWith('https://image.test/')).toBe(true);
  });

  it('refuses to FOLLOW a redirect — the only way left to reach a host we did not choose', async () => {
    await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').catch(() => undefined);

    // The host is ours by construction now, so a 3xx off it is the residual hazard. `error`
    // rather than `follow`: node resolves a redirect itself, so `follow` would re-open one
    // hop later exactly what the narrowing closed.
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('bounds the fetch with a timeout — an unbounded one pins a web-pod request', async () => {
    await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').catch(() => undefined);

    const init = mockFetch.mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses an oversized body declared by Content-Length, before buffering it', async () => {
    // 🔴 THE FIXTURE IS THE ASSERTION HERE, and the obvious version does not work. A first
    // draft made `arrayBuffer` THROW ("must not buffer"), reasoning that reaching it was the
    // failure. It is not detectable that way: with the pre-check deleted the code calls
    // `arrayBuffer`, the throw is caught by the same try/catch, and the SAME generic message
    // comes back — so the row passed with the guard removed. MEASURED: that mutant survived a
    // 14/14 green run.
    //
    // The isolating fixture declares a huge Content-Length while returning a TINY body. Now
    // the pre-check is the only thing that can refuse: delete it and the fetch succeeds,
    // sharp runs, and `not.toHaveBeenCalled()` below goes red.
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? String(64 * 1024 * 1024) : null) },
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    const err = await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').then(
      () => null,
      (e: unknown) => e
    );
    // Surfaces as the generic read failure (the cap throws INSIDE the existing try/catch, by
    // design — it is a fetch failure, not a validation verdict about the url).
    expect(err instanceof Error ? err.message : String(err)).toContain(
      'Could not read the uploaded artwork'
    );
    expect(mockSharp).not.toHaveBeenCalled();
  });

  it('refuses an oversized body that declared NO Content-Length (the chunked case)', async () => {
    // 🔴 The row that makes the Content-Length check non-sufficient: a chunked response
    // carries no length to pre-check, so the streamed total must be checked too. Without the
    // second check this passes and sharp is handed 64 MiB.
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(64 * 1024 * 1024),
    });

    const err = await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').then(
      () => null,
      (e: unknown) => e
    );
    expect(err instanceof Error ? err.message : String(err)).toContain(
      'Could not read the uploaded artwork'
    );
    expect(mockSharp).not.toHaveBeenCalled();
  });
});
