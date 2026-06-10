import { describe, expect, it, vi } from 'vitest';

// The handler module imports ~/server/db/client (Prisma init at module load).
// We only exercise the pure expectedImageRef helper, so stub the db +
// pipeline deps to keep the import side-effect-free.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerApply: vi.fn(),
  waitForApplyJob: vi.fn(),
}));

import { expectedImageRef } from '~/pages/api/internal/blocks/build-callback';

/**
 * L-CALLBACK coverage. The build-callback handler accepts an `imageRef` from
 * the Tekton pipeline. The pipeline always pushes the immutable
 * `ghcr.io/civitai/app-block-<slug>:<sha>`. The handler must bind the
 * accepted ref to ITS OWN slug + sha — a bare `app-block-` prefix check would
 * let a signature-valid callback for slug A carry `app-block-<B>:<sha>` and
 * deploy B's image onto A's row/Deployment, and would accept a mutable
 * `:latest` tag.
 */
describe('build-callback imageRef binding', () => {
  const SHA = 'a'.repeat(40);

  it('accepts exactly the canonical (slug, sha) image', () => {
    const slug = 'generate-from-model';
    const ref = expectedImageRef(slug, SHA);
    expect(ref).toBe(`ghcr.io/civitai/app-block-${slug}:${SHA}`);
    expect(ref === expectedImageRef(slug, SHA)).toBe(true);
  });

  it('rejects another slug under the same prefix', () => {
    const ours = expectedImageRef('slug-a', SHA);
    const theirs = `ghcr.io/civitai/app-block-slug-b:${SHA}`;
    expect(ours === theirs).toBe(false);
    // the handler compares body.imageRef !== expectedImageRef(body.slug, body.sha)
    expect(theirs === expectedImageRef('slug-a', SHA)).toBe(false);
  });

  it('rejects a mutable :latest tag for our own slug', () => {
    const slug = 'slug-a';
    const latest = `ghcr.io/civitai/app-block-${slug}:latest`;
    expect(latest === expectedImageRef(slug, SHA)).toBe(false);
  });

  it('rejects a different sha for our own slug', () => {
    const slug = 'slug-a';
    const otherSha = 'b'.repeat(40);
    expect(expectedImageRef(slug, otherSha) === expectedImageRef(slug, SHA)).toBe(false);
  });

  it('rejects a prefix-matching but unrelated repo', () => {
    const slug = 'slug-a';
    const sneaky = `ghcr.io/civitai/app-block-${slug}-evil:${SHA}`;
    expect(sneaky === expectedImageRef(slug, SHA)).toBe(false);
  });
});
