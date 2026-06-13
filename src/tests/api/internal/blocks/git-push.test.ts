import { createHmac } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// withAxiom is a passthrough in tests (its closure is captured at module load,
// and we don't need the Axiom transport for handler behaviour).
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

// The handler module imports ~/server/db/client (which inits Prisma at module
// load and reads env.LOGGING.filter). The pure parseExpectedRepo +
// verifyForgejoSignature + checkDeliveryNonce tests don't touch the db, but the
// handler-level retry-after-failure test (F5-A) does — so give dbRead/dbWrite
// mockable surfaces here.
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
vi.mock('~/server/db/client', () => ({
  dbRead: { appBlock: { findFirst: mockFindFirst } },
  dbWrite: { appBlock: { update: mockUpdate } },
}));

const mockTriggerBuild = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: mockTriggerBuild,
}));

const mockIsFlipt = vi.hoisted(() => vi.fn());
vi.mock('~/server/flipt/client', () => ({ isFlipt: mockIsFlipt }));

// Forgejo side-effects (commit status + manifest fetch) — mockable so the
// handler test can drive a manifest-fetch failure and a happy retry.
const mockGetRawFile = vi.hoisted(() => vi.fn());
const mockSetCommitStatus = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  getRawFile: mockGetRawFile,
  setCommitStatus: mockSetCommitStatus,
}));

// Validator — default to valid; the handler test only needs the valid path.
const mockValidate = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: mockValidate },
}));

// Mockable sysRedis.set + .del so the F5 per-delivery dedup nonce (claim +
// F5-A release-on-failure) can be exercised at both the pure-fn and handler
// level. The handler-level test asserts .del is called on a downstream failure.
const mockSet = vi.hoisted(() => vi.fn());
const mockDel = vi.hoisted(() => vi.fn());
vi.mock('~/server/redis/client', () => ({
  sysRedis: { set: mockSet, del: mockDel },
  REDIS_SYS_KEYS: { BLOCKS: { GITPUSH_DELIVERY: 'system:blocks:gitpush:delivery' } },
}));

// Mutable env mock so each test can set / clear FORGEJO_WEBHOOK_SECRET[_NEXT]
// to exercise the dual-acceptance rotation window (F6). Overrides the global
// ~/env/server mock in src/__tests__/setup.ts for this file. vi.hoisted so the
// object exists before the hoisted vi.mock factory runs.
const mockEnv = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import handler, {
  checkDeliveryNonce,
  parseExpectedRepo,
  verifyForgejoSignature,
} from '~/pages/api/internal/blocks/git-push';

/**
 * M-WEBHOOK coverage. The git-push webhook is authenticated only by the
 * shared FORGEJO_WEBHOOK_SECRET, which proves the request came from the
 * Forgejo *instance* — not from a specific org. The same instance also
 * hosts the `civitai-apps-review` org (anonymous in-review browsing). Without
 * an org check, a signature-valid push to a same-slug repo in any other org
 * would drive a build + auto-approve of the canonical app_blocks row.
 * parseExpectedRepo gates on the canonical org and derives the slug from
 * `repository.full_name` so org + slug are validated together.
 */
describe('parseExpectedRepo', () => {
  const ORG = 'civitai-apps';

  it('accepts a repo in the canonical org and returns the slug', () => {
    expect(parseExpectedRepo('civitai-apps/generate-from-model', ORG)).toEqual({
      slug: 'generate-from-model',
    });
  });

  it('rejects a same-slug repo in the in-review org', () => {
    expect(parseExpectedRepo('civitai-apps-review/generate-from-model', ORG)).toBeNull();
  });

  it('rejects any other org', () => {
    expect(parseExpectedRepo('attacker/generate-from-model', ORG)).toBeNull();
    expect(parseExpectedRepo('civitai-apps-evil/generate-from-model', ORG)).toBeNull();
  });

  it('rejects a bare slug with no org prefix (the old repository.name shape)', () => {
    expect(parseExpectedRepo('generate-from-model', ORG)).toBeNull();
  });

  it('rejects missing / non-string full_name', () => {
    expect(parseExpectedRepo(undefined, ORG)).toBeNull();
    expect(parseExpectedRepo(null, ORG)).toBeNull();
    expect(parseExpectedRepo(42, ORG)).toBeNull();
    expect(parseExpectedRepo('', ORG)).toBeNull();
  });

  it('rejects an org with an empty slug', () => {
    expect(parseExpectedRepo('civitai-apps/', ORG)).toBeNull();
  });
});

/**
 * F6 — dual-secret HMAC rotation window. verifyForgejoSignature must accept a
 * signature computed under the CURRENT secret OR the optional *_NEXT secret, so
 * the secret can be rotated without an outage. With _NEXT unset the behavior is
 * unchanged (single-secret, fail-closed).
 */
describe('verifyForgejoSignature dual-secret window (F6)', () => {
  const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40) }));
  const sign = (secret: string, raw = body) =>
    createHmac('sha256', secret).update(raw).digest('hex');

  beforeEach(() => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = undefined;
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = undefined;
  });
  afterEach(() => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = undefined;
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = undefined;
  });

  it('accepts a signature valid under the current secret', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'current-secret';
    expect(verifyForgejoSignature(body, sign('current-secret'))).toBe(true);
  });

  it('accepts a signature valid under the NEXT secret (new signer) during rotation', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'old-secret';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'new-secret';
    // Signed with the NEW secret — must be accepted while NEXT is set.
    expect(verifyForgejoSignature(body, sign('new-secret'))).toBe(true);
    // The old secret is still accepted too (in-flight builds from the old signer).
    expect(verifyForgejoSignature(body, sign('old-secret'))).toBe(true);
  });

  it('tolerates a sha256= prefix on either secret', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'old-secret';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'new-secret';
    expect(verifyForgejoSignature(body, `sha256=${sign('new-secret')}`)).toBe(true);
  });

  it('rejects a NEXT-signed signature when NEXT is unset (unchanged single-secret behavior)', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'current-secret';
    // NEXT unset — a signature under some other secret must NOT be accepted.
    expect(verifyForgejoSignature(body, sign('some-future-secret'))).toBe(false);
  });

  it('still rejects a garbage signature with both secrets set', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'old-secret';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'new-secret';
    expect(verifyForgejoSignature(body, 'deadbeef')).toBe(false);
    expect(verifyForgejoSignature(body, '')).toBe(false);
    expect(verifyForgejoSignature(body, undefined)).toBe(false);
    expect(verifyForgejoSignature(body, sign('wrong-secret'))).toBe(false);
  });

  it('fails closed when no secret is configured (no current, no NEXT)', () => {
    expect(verifyForgejoSignature(body, sign('anything'))).toBe(false);
  });
});

/**
 * F5 — per-delivery dedup nonce. SET NX EX on the X-Gitea-Delivery id. First
 * delivery wins ('first'); a redelivery with the same id is a 'duplicate'.
 * Header absent / malformed / Redis error → 'skip' (never block a legit push).
 * NOTE (honest limitation, documented in checkDeliveryNonce): X-Gitea-Delivery
 * is NOT HMAC-covered, so this catches naive redeliveries only.
 */
describe('git-push checkDeliveryNonce (F5 delivery nonce)', () => {
  beforeEach(() => {
    mockSet.mockReset();
  });

  it("treats a new delivery id as 'first' (NX set succeeds → 'OK')", async () => {
    mockSet.mockResolvedValueOnce('OK');
    await expect(checkDeliveryNonce('delivery-uuid-1')).resolves.toBe('first');
    expect(mockSet).toHaveBeenCalledWith(
      'system:blocks:gitpush:delivery:delivery-uuid-1',
      '1',
      { NX: true, EX: 600 }
    );
  });

  it("treats a repeated delivery id as 'duplicate' (NX returns null)", async () => {
    mockSet.mockResolvedValueOnce(null);
    await expect(checkDeliveryNonce('delivery-uuid-1')).resolves.toBe('duplicate');
  });

  it("skips when the delivery header is absent → 'skip' (no Redis call)", async () => {
    await expect(checkDeliveryNonce(undefined)).resolves.toBe('skip');
    await expect(checkDeliveryNonce(null)).resolves.toBe('skip');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("skips a malformed / oversized delivery id → 'skip'", async () => {
    await expect(checkDeliveryNonce('bad id with spaces')).resolves.toBe('skip');
    await expect(checkDeliveryNonce('x'.repeat(65))).resolves.toBe('skip');
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("uses the first element when the header arrives as an array", async () => {
    mockSet.mockResolvedValueOnce('OK');
    await expect(checkDeliveryNonce(['delivery-uuid-2', 'ignored'])).resolves.toBe('first');
    expect(mockSet).toHaveBeenCalledWith(
      'system:blocks:gitpush:delivery:delivery-uuid-2',
      '1',
      { NX: true, EX: 600 }
    );
  });

  it("skips on a Redis error → 'skip' (never block a legit push)", async () => {
    mockSet.mockRejectedValueOnce(new Error('redis down'));
    await expect(checkDeliveryNonce('delivery-uuid-3')).resolves.toBe('skip');
  });
});

/**
 * F5-A (the headline regression) — HANDLER-LEVEL. The delivery nonce is claimed
 * BEFORE downstream processing. If a transient downstream failure (here:
 * triggerBuild throwing) lands AFTER the claim, the handler MUST release the
 * nonce so Forgejo's redelivery of the SAME X-Gitea-Delivery id can re-process
 * the build — otherwise the build is permanently swallowed as a "duplicate"
 * (a new availability hole). This is the test that would have caught F5-A.
 *
 * It drives the real handler (not just the pure helper) so it exercises the
 * actual claim → fail → DEL → retry → process path.
 */
describe('git-push handler — F5-A nonce release on downstream failure', () => {
  const SECRET = 'forgejo-secret';
  const SLUG = 'generate-from-model';
  const SHA = 'a'.repeat(40);
  const DELIVERY_ID = 'retry-delivery-id-1';
  const DELIVERY_KEY = `system:blocks:gitpush:delivery:${DELIVERY_ID}`;

  function pushBody(): Buffer {
    return Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: SHA,
        repository: { name: SLUG, full_name: `civitai-apps/${SLUG}` },
      })
    );
  }

  function makeReq(raw: Buffer): NextApiRequest {
    // The handler reads the raw stream via `for await (const chunk of req)`.
    const stream = Readable.from([raw]) as unknown as NextApiRequest;
    const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
    stream.method = 'POST';
    stream.headers = {
      'x-gitea-signature': sig,
      'x-gitea-delivery': DELIVERY_ID,
    };
    return stream;
  }

  function makeRes(): NextApiResponse & { _status: number; _body: unknown } {
    const res = {
      _status: 0,
      _body: null as unknown,
      status(this: any, n: number) {
        this._status = n;
        return this;
      },
      json(this: any, b: unknown) {
        this._body = b;
        return this;
      },
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    return res as unknown as NextApiResponse & { _status: number; _body: unknown };
  }

  // A tiny in-memory Redis stub so the nonce truly round-trips claim → del →
  // re-claim across the two deliveries (the whole point of the regression test).
  let store: Set<string>;

  beforeEach(() => {
    store = new Set<string>();
    mockEnv.FORGEJO_WEBHOOK_SECRET = SECRET;
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = undefined;
    mockEnv.APPS_DOMAIN = 'civitaiapps.com';

    mockSet.mockReset();
    mockDel.mockReset();
    // SET NX semantics over the in-memory store.
    mockSet.mockImplementation(async (key: string) => {
      if (store.has(key)) return null;
      store.add(key);
      return 'OK';
    });
    mockDel.mockImplementation(async (key: string) => {
      const had = store.delete(key);
      return had ? 1 : 0;
    });

    mockIsFlipt.mockResolvedValue(true);
    mockFindFirst.mockResolvedValue({
      id: 'apb_0123456789ABCDEFGHJKMNPQ',
      appId: 'app_1',
      blockId: SLUG,
      app: { id: 'app_1', allowedScopes: 0, allowedOrigins: [] },
    });
    mockUpdate.mockResolvedValue({});
    mockGetRawFile.mockResolvedValue(
      JSON.stringify({
        blockId: SLUG,
        version: '1.0.0',
        iframe: { src: `https://${SLUG}.civitaiapps.com/` },
      })
    );
    mockValidate.mockReturnValue({ valid: true, errors: [] });
    mockSetCommitStatus.mockResolvedValue(undefined);
    mockTriggerBuild.mockReset();
  });

  afterEach(() => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = undefined;
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = undefined;
    mockEnv.APPS_DOMAIN = undefined;
  });

  it('releases the nonce on a triggerBuild failure, then re-processes the same delivery id on retry', async () => {
    process.env.NEXTAUTH_URL = 'https://civitai.test';

    // --- Delivery #1: triggerBuild throws (transient Tekton failure) ---------
    mockTriggerBuild.mockRejectedValueOnce(new Error('tekton receiver down'));
    const res1 = makeRes();
    await handler(makeReq(pushBody()), res1);

    // Non-2xx (the build trigger failed) ...
    expect(res1._status).toBeGreaterThanOrEqual(400);
    expect(res1._status).toBe(500);
    // ... AND the nonce key was deleted so a retry is allowed.
    expect(mockDel).toHaveBeenCalledWith(DELIVERY_KEY);
    expect(store.has(DELIVERY_KEY)).toBe(false);

    // --- Delivery #2: SAME id, failure cleared → must PROCESS (not skip) ------
    mockTriggerBuild.mockResolvedValueOnce({ name: 'pr-1' });
    const res2 = makeRes();
    await handler(makeReq(pushBody()), res2);

    expect(res2._status).toBe(200);
    expect(res2._body).toMatchObject({ ok: true, slug: SLUG, sha: SHA });
    // The retry actually drove the build (NOT swallowed as a duplicate).
    expect(mockTriggerBuild).toHaveBeenCalledTimes(2);
    // And the nonce is now held (success path keeps it) so a 3rd identical
    // delivery WOULD be deduped.
    expect(store.has(DELIVERY_KEY)).toBe(true);
  });

  it('releases the nonce when dbWrite.appBlock.update throws (R2-F5-A1), then re-processes on retry', async () => {
    // R2-F5-A1 (the exact gap the per-path releases missed): the
    // dbWrite.appBlock.update is reached AFTER the nonce is claimed and BEFORE
    // triggerBuild. If it throws (DB blip / pool exhaustion / replica
    // promotion), withAxiom returns a 500 — and without the outer try/catch the
    // nonce stays held, so Forgejo's same-id retry is swallowed as a duplicate
    // and the build is permanently lost. The handler must release the nonce on
    // this throw too. This is the test that would have caught R2-F5-A1.
    process.env.NEXTAUTH_URL = 'https://civitai.test';

    // --- Delivery #1: the DB update throws (transient DB failure) -------------
    mockUpdate.mockRejectedValueOnce(new Error('connection pool exhausted'));
    const res1 = makeRes();
    // withAxiom is a passthrough in tests, so the throw propagates out of the
    // handler (in prod withAxiom turns it into a 500). Assert it's non-2xx by
    // confirming the success/skip responses were NOT sent AND the throw escaped.
    await expect(handler(makeReq(pushBody()), res1)).rejects.toThrow(
      'connection pool exhausted'
    );
    // Non-2xx: the success 200 body was never written.
    expect(res1._status).not.toBe(200);
    expect(res1._body).toBeNull();
    // The DB update threw before triggerBuild ran.
    expect(mockTriggerBuild).not.toHaveBeenCalled();
    // ... AND the nonce key was released so a retry is allowed.
    expect(mockDel).toHaveBeenCalledWith(DELIVERY_KEY);
    expect(store.has(DELIVERY_KEY)).toBe(false);

    // --- Delivery #2: SAME id, DB recovered → must PROCESS (not skip) ---------
    mockUpdate.mockResolvedValueOnce({});
    mockTriggerBuild.mockResolvedValueOnce({ name: 'pr-3' });
    const res2 = makeRes();
    await handler(makeReq(pushBody()), res2);

    expect(res2._status).toBe(200);
    expect(res2._body).toMatchObject({ ok: true, slug: SLUG, sha: SHA });
    // The retry actually drove the build (NOT swallowed as a duplicate).
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
    // The nonce is now held (success keeps it) so a 3rd identical delivery
    // WOULD be deduped.
    expect(store.has(DELIVERY_KEY)).toBe(true);
  });

  it('KEEPS the nonce on success so a duplicate of a completed delivery is deduped', async () => {
    process.env.NEXTAUTH_URL = 'https://civitai.test';
    mockTriggerBuild.mockResolvedValue({ name: 'pr-2' });

    const res1 = makeRes();
    await handler(makeReq(pushBody()), res1);
    expect(res1._status).toBe(200);
    expect(store.has(DELIVERY_KEY)).toBe(true);
    expect(mockDel).not.toHaveBeenCalledWith(DELIVERY_KEY);

    // Duplicate delivery of the completed run → 200 skipped, no second build.
    const res2 = makeRes();
    await handler(makeReq(pushBody()), res2);
    expect(res2._status).toBe(200);
    expect(res2._body).toMatchObject({ skipped: 'duplicate delivery' });
    expect(mockTriggerBuild).toHaveBeenCalledTimes(1);
  });
});
