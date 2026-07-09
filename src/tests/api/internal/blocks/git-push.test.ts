import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));

// The handler module imports ~/server/db/client (which inits Prisma at module
// load and reads env.LOGGING.filter). The pure parseExpectedRepo +
// verifyForgejoSignature tests don't touch the db, but the import side-effect
// would still run — stub the db + pipeline + flipt deps to keep the import
// side-effect-free.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn(async () => true) }));
// Include listRepoTreeAtRef + getBlobContent even though git-push.ts doesn't use them: under a
// saturated worker pool this partial factory could leak into a co-resident file whose graph DOES
// reach them (publish-request.service → reconstructBundleFromForgejo), surfacing as
// "No 'listRepoTreeAtRef' export is defined on the mock". Completing the surface removes that leak.
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  FORGEJO_ORG: 'civitai-apps',
  getRawFile: vi.fn(),
  setCommitStatus: vi.fn(),
  listRepoTreeAtRef: vi.fn(),
  getBlobContent: vi.fn(),
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: vi.fn(() => ({ valid: true, errors: [] })) },
}));

// Mutable env mock so each test can set / clear FORGEJO_WEBHOOK_SECRET[_NEXT]
// before exercising the dual-secret rotation window. vi.hoisted so the object
// exists before the hoisted vi.mock factory runs.
const mockEnv = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { parseExpectedRepo, verifyForgejoSignature } from '~/pages/api/internal/blocks/git-push';

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
 * the secret can be rotated without an outage. With _NEXT unset the behaviour is
 * byte-identical to the prior single-secret implementation (fail-closed when no
 * secret is configured).
 */
describe('verifyForgejoSignature dual-secret window (F6)', () => {
  const body = Buffer.from('{"ref":"refs/heads/main","after":"abc"}', 'utf8');
  const sign = (secret: string) => createHmac('sha256', secret).update(body).digest('hex');

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

  it('accepts the `sha256=` prefixed header form too', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'current-secret';
    expect(verifyForgejoSignature(body, `sha256=${sign('current-secret')}`)).toBe(true);
  });

  it('accepts a signature valid under the NEXT secret (new signer) during rotation', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'old-secret';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'new-secret';
    // New signer (NEXT) is accepted...
    expect(verifyForgejoSignature(body, sign('new-secret'))).toBe(true);
    // ...AND the old signer is still accepted in the same window.
    expect(verifyForgejoSignature(body, sign('old-secret'))).toBe(true);
  });

  it('rejects a signature under neither secret', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'old-secret';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'new-secret';
    expect(verifyForgejoSignature(body, sign('attacker-secret'))).toBe(false);
  });

  it('NEXT unset → identical single-secret behaviour (current accepted, others rejected)', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'only-secret';
    expect(verifyForgejoSignature(body, sign('only-secret'))).toBe(true);
    expect(verifyForgejoSignature(body, sign('other'))).toBe(false);
  });

  it('fails closed when NO secret is configured (never an empty-key HMAC)', () => {
    // Neither secret set → must reject regardless of the provided signature,
    // including a signature computed with an empty key.
    expect(verifyForgejoSignature(body, sign(''))).toBe(false);
    expect(verifyForgejoSignature(body, sign('anything'))).toBe(false);
  });

  it('ignores an empty-string secret (does not compute an empty-key HMAC)', () => {
    // An empty-string FORGEJO_WEBHOOK_SECRET must be filtered out, so a
    // signature computed with the empty key must NOT validate.
    mockEnv.FORGEJO_WEBHOOK_SECRET = '';
    mockEnv.FORGEJO_WEBHOOK_SECRET_NEXT = 'real-next';
    expect(verifyForgejoSignature(body, sign(''))).toBe(false);
    // The real NEXT secret still works.
    expect(verifyForgejoSignature(body, sign('real-next'))).toBe(true);
  });

  it('rejects a missing / empty / non-string header', () => {
    mockEnv.FORGEJO_WEBHOOK_SECRET = 'current-secret';
    expect(verifyForgejoSignature(body, undefined)).toBe(false);
    expect(verifyForgejoSignature(body, '')).toBe(false);
    expect(verifyForgejoSignature(body, 42 as unknown)).toBe(false);
  });
});
