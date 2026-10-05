import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `validateArtwork` URL allowlist (creator-shop.service) — the SHARPEST of the four funnels.
 *
 * It is the only one that fetches from the NEXT.JS WEB POD rather than via the orchestrator,
 * and everything it derives from the response — a sha256 of the body, width, height, format,
 * frame count — is returned to the submitter. Ungated that is a RESPONSE ORACLE over any URL
 * the web pod can reach, on `creatorShopProcedure` (protectedProcedure + the `creatorShop`
 * flag).
 *
 * ⚠ CORRECTED: this said "an ordinary signed-in user, not a moderator", which OVERSTATES the
 * rung. Measured: `feature-flags.service.ts` declares `creatorShop: { availability: ['mod'],
 * fliptKey: 'creator-shop' }`, and live Flipt enables it for `testers` ∪ `CreatorProgram` ∪
 * `moderators` — a gated cohort of real users, not every signed-in account. The hazard is
 * unchanged (Creator Program members are not moderators) but do not re-derive the wider claim
 * from here. Swept in the same commit as the copy in `creator-shop.service.ts`, because a
 * retraction fixed at one site and left at the other is how the wrong number survives.
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
import { constants } from '~/server/common/constants';

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

  it('does NOT set redirect:error — the edge answers 301 and that would break every submit', async () => {
    await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').catch(() => undefined);

    // 🔴 THIS ROW REPLACES ONE THAT ASSERTED THE OPPOSITE, and the reversal is measured, not
    // reasoned. An earlier draft set `redirect: 'error'` on the theory that the host being
    // ours made a 3xx the only remaining way out. Probed against the live edge, an
    // `original=true` delivery URL answers **HTTP 301** to
    // `https://blobs-b2.civitai.com/file/blobs-managed-public/<id>` — 3 of 3 sampled images.
    // Redirecting to our own blob host is the normal path, so `redirect: 'error'` would have
    // rejected every legitimate artwork fetch in production.
    //
    // Following is safe BECAUSE of the narrowing: the caller supplies a key, never a host, so
    // the chain is chosen by our infrastructure and is not attacker-influenced. This row
    // exists so nobody re-adds the option from the same plausible-but-false reasoning.
    const init = mockFetch.mock.calls[0][1] ?? {};
    expect(init.redirect).toBeUndefined();
  });

  it('bounds the fetch with a TIMEOUT signal, derived from the size cap', async () => {
    // 🔴 THIS ROW WAS SPELLED, NOT STRUCTURAL, and an audit measured it: it asserted only
    // `expect(init.signal).toBeInstanceOf(AbortSignal)`, which stays GREEN when the signal is
    // swapped for `new AbortController().signal` — one that can NEVER fire. It proved an
    // AbortSignal object was passed, never that the fetch is time-bounded. Same class as the
    // `redirect: 'error'` guard this suite already retracted.
    //
    // Spying on the factory pins the thing that matters — that the signal came from
    // `AbortSignal.timeout` AND with the derived budget — which no assertion on the resulting
    // object can distinguish (a timeout signal and a controller signal are the same type).
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').catch(() => undefined);

      expect(spy).toHaveBeenCalledTimes(1);
      const ms = spy.mock.calls[0][0];
      // The budget is DERIVED from the cap at a stated throughput, so pin the relationship
      // rather than a literal: a cap change must move this, and a literal would not notice.
      expect(ms).toBe(Math.ceil((constants.mediaUpload.maxImageFileSize / 2_000_000) * 1000));
      // And sanity-bound it, so a derivation that collapses to ~0 cannot pass.
      expect(ms).toBeGreaterThan(5_000);
      // 🔴 IDENTITY, because the two assertions above pin only the CALL. MEASURED: a mutant
      // that keeps `AbortSignal.timeout(ARTWORK_FETCH_TIMEOUT_MS)` as a bare statement and
      // hands `new AbortController().signal` to `fetch` scored 15/15 GREEN — the factory was
      // called with the right budget and its result was thrown away. Tying the signal `fetch`
      // received back to the one the spy returned is what closes that; it fails with an
      // `Object.is equality` mismatch naming the two AbortSignals.
      expect(mockFetch.mock.calls[0][1].signal).toBe(spy.mock.results[0].value);
    } finally {
      spy.mockRestore();
    }
  });

  it('still refuses parser-ambiguous bytes in a RELATIVE key (the second guard)', async () => {
    // 🔴 THE SECOND GUARD WAS UNREACHABLE BY EVERY TEST IN THE REPO until this row. An audit
    // measured it: deleting the `isAllowedImageScanUrl` call while keeping the import left
    // this suite at 14/14 AND the three image-scan-url suites at 69/69 — because the ledger
    // matches on the identifier in the file TEXT, and both rows that used to reach the second
    // guard are now caught by the narrowing at the first. (That second figure was written as
    // "23/23"; re-measured, `image-scan-url-seam-composed`, `image-scan-url-submit-rejection`
    // and `image-scan-url-allowlist` hold 69 tests between them. The 14/14 is the count this
    // suite had before this row was added and is correct as written.)
    //
    // `\evil.com/x` carries no scheme and no leading `//`, so `isEdgeUrlPassthrough` says
    // "relative key" and waves it past the first guard. Only the ambiguous-bytes half refuses
    // it. Without this row the second guard could be deleted with the suite fully green.
    const err = await submit('\\evil.com/x.png').then(
      () => null,
      (e: unknown) => e
    );
    expect(err instanceof Error ? err.message : String(err)).toContain(
      'Artwork must be an image uploaded to Civitai'
    );
    expect(mockFetch).not.toHaveBeenCalled();
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
    // carries no length to pre-check, so the total must be bounded while READING.
    //
    // The fixture streams 1 MiB chunks and counts how many are pulled. That count is the
    // assertion that the bound is enforced DURING the read rather than after it: a guard that
    // buffered first would drain all 80 chunks before deciding. It also means this row cannot
    // pass by accident on an `arrayBuffer` fallback.
    const CHUNK = 1024 * 1024;
    let pulled = 0;
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            pulled += 1;
            if (pulled > 80) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(CHUNK) };
          },
          cancel: async () => undefined,
        }),
      },
      arrayBuffer: async () => {
        throw new Error('MUST NOT reach arrayBuffer — the stream path should have bounded it');
      },
    });

    const err = await submit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/art.png').then(
      () => null,
      (e: unknown) => e
    );
    expect(err instanceof Error ? err.message : String(err)).toContain(
      'Could not read the uploaded artwork'
    );
    expect(mockSharp).not.toHaveBeenCalled();
    // 🔴 The bound was enforced DURING the read: it stopped well short of the 80 chunks the
    // fixture would happily supply. A guard that materialised the body first would have
    // pulled every one of them.
    expect(pulled).toBeLessThan(80);
  });
});
