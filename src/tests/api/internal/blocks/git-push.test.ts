import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The handler module imports ~/server/db/client (which inits Prisma at module
// load and reads env.LOGGING.filter). We only exercise the pure
// parseExpectedRepo + verifyForgejoSignature helpers, so stub the db + pipeline
// deps to keep the import side-effect-free.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn() }));

// Mockable sysRedis.set so the F5 per-delivery dedup nonce can be exercised.
const mockSet = vi.hoisted(() => vi.fn());
vi.mock('~/server/redis/client', () => ({
  sysRedis: { set: mockSet },
  REDIS_SYS_KEYS: { BLOCKS: { GITPUSH_DELIVERY: 'system:blocks:gitpush:delivery' } },
}));

// Mutable env mock so each test can set / clear FORGEJO_WEBHOOK_SECRET[_NEXT]
// to exercise the dual-acceptance rotation window (F6). Overrides the global
// ~/env/server mock in src/__tests__/setup.ts for this file. vi.hoisted so the
// object exists before the hoisted vi.mock factory runs.
const mockEnv = vi.hoisted(() => ({} as Record<string, string | undefined>));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import {
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
