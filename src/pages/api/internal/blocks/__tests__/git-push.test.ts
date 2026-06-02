import { describe, expect, it, vi } from 'vitest';

// The handler module imports ~/server/db/client (which inits Prisma at module
// load and reads env.LOGGING.filter). We only exercise the pure
// parseExpectedRepo helper, so stub the db + pipeline deps to keep the import
// side-effect-free.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(),
}));

import { parseExpectedRepo } from '../git-push';

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
