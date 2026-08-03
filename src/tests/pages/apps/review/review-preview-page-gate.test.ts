import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — full-page review preview SSR gate
 * (`/apps/review/preview/<publishRequestId>`).
 *
 * Mirrors `run-page-maturity.test.ts`: we mock `createServerSideProps` to capture
 * the resolver, then invoke it with a controlled `features`/`session`/`ctx`. The
 * gate must mirror `/apps/review` exactly — `appBlocks` off → 404, no session →
 * login redirect, non-moderator → 404 — plus resolve the `slug` server-side and
 * 404 a missing / non-pending request.
 *
 * NOTE: this test lives under `src/tests/` (NOT co-located under `src/pages/`).
 * Next treats every file under `pages/` as a route needing a default export, so a
 * `*.test.ts` there fails `next build`'s route-type validator (tsc/vitest do not
 * catch it). The page module is imported via the `~/pages/...` alias.
 */

const { capturedResolver } = vi.hoisted(() => ({
  capturedResolver: { fn: null as null | ((c: any) => Promise<any>) },
}));

vi.mock('~/server/utils/server-side-helpers', () => ({
  createServerSideProps: (opts: { resolver: (c: any) => Promise<any> }) => {
    capturedResolver.fn = opts.resolver;
    return async () => ({ props: {} });
  },
}));

const { mockResolveReviewPreviewTarget } = vi.hoisted(() => ({
  mockResolveReviewPreviewTarget: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  resolveReviewPreviewTarget: mockResolveReviewPreviewTarget,
}));

vi.mock('~/utils/login-helpers', () => ({
  getLoginLink: ({ returnUrl }: { returnUrl: string }) => `/login?returnUrl=${returnUrl}`,
}));

// The page imports React/Mantine/component bits at module top; stub the heavy
// ones so importing the page module in a node unit test doesn't pull a DOM. The
// resolver (the unit under test) touches none of them. `isAppReviewer` is left
// REAL (it's a pure predicate) so the moderator gate is exercised for real.
vi.mock('@mantine/core', () => ({
  Alert: () => null,
  Box: () => null,
  Button: () => null,
  Group: () => null,
  Loader: () => null,
  Stack: () => null,
  Text: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconArrowLeft: () => null,
  IconWindow: () => null,
  IconX: () => null,
}));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('~/components/AppLayout/NotFound', () => ({ NotFound: () => null }));
vi.mock('~/components/Apps/ReviewBlockPreviewHost', () => ({ ReviewBlockPreviewHost: () => null }));
vi.mock('~/components/Apps/useReviewPreview', () => ({ useReviewPreview: () => ({}) }));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({ useFeatureFlags: () => ({ appBlocks: true }) }));

function makeCtx(
  opts: {
    appBlocks?: boolean;
    user?: { isModerator?: boolean } | null;
    publishRequestId?: string | undefined;
    resolvedUrl?: string;
  } = {}
) {
  const {
    appBlocks = true,
    user = { isModerator: true } as { isModerator?: boolean } | null,
    resolvedUrl = '/apps/review/preview/pubreq_1',
  } = opts;
  // Read via `in` so an EXPLICIT `{ publishRequestId: undefined }` models a
  // missing route param (a destructuring default would wrongly re-apply the id).
  const publishRequestId = 'publishRequestId' in opts ? opts.publishRequestId : 'pubreq_1';
  return {
    features: { appBlocks },
    session: user ? { user } : null,
    ctx: { params: { publishRequestId }, resolvedUrl },
  };
}

async function loadResolver() {
  await import('~/pages/apps/review/preview/[publishRequestId]');
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn;
}

describe('review-preview page SSR — moderator + flag gate', () => {
  beforeEach(() => {
    // Only reset the service mock — NOT capturedResolver (ESM module cache means
    // createServerSideProps captures the resolver on the FIRST import only).
    mockResolveReviewPreviewTarget.mockReset();
  });

  it('404s when the appBlocks flag is off', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ appBlocks: false }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewPreviewTarget).not.toHaveBeenCalled();
  });

  it('redirects to login when there is no session', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ user: null }));
    expect(result.redirect?.destination).toContain('/login');
    expect(result.redirect?.permanent).toBe(false);
  });

  it('404s for a logged-in NON-moderator', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ user: { isModerator: false } }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewPreviewTarget).not.toHaveBeenCalled();
  });

  it('404s when the publishRequestId param is missing', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: undefined }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewPreviewTarget).not.toHaveBeenCalled();
  });

  it('404s when the request is missing / not pending (resolver returns null)', async () => {
    mockResolveReviewPreviewTarget.mockResolvedValue(null);
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: 'pubreq_missing' }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewPreviewTarget).toHaveBeenCalledWith('pubreq_missing');
  });

  it('returns props with the resolved slug for a valid moderator + pending request', async () => {
    mockResolveReviewPreviewTarget.mockResolvedValue({ id: 'pubreq_1', slug: 'my-block' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: 'pubreq_1' }));
    expect(result).toEqual({ props: { publishRequestId: 'pubreq_1', slug: 'my-block' } });
  });
});
