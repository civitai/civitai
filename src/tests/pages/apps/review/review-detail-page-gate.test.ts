import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PER-SUBMISSION REVIEW PAGE SSR gate (`/apps/review/<publishRequestId>`).
 *
 * Mirrors `review-preview-page-gate.test.ts`: mock `createServerSideProps` to
 * capture the resolver, then invoke it with a controlled `features`/`session`/
 * `ctx`. The gate must mirror `/apps/review` PLUS the new `appReviewPage` flag —
 * `appBlocks` off → 404, `appReviewPage` off → 404, no session → login redirect,
 * non-moderator → 404, missing id → 404, missing/withdrawn request
 * (`resolveReviewRequestTarget` → null) → 404, valid → typed props.
 *
 * Lives under `src/tests/` (NOT co-located under `src/pages/`) — Next treats
 * every file under `pages/` as a route needing a default export.
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

const { mockResolveReviewRequestTarget } = vi.hoisted(() => ({
  mockResolveReviewRequestTarget: vi.fn<(...a: any[]) => Promise<any>>(),
}));
vi.mock('~/server/services/blocks/publish-request.service', () => ({
  resolveReviewRequestTarget: mockResolveReviewRequestTarget,
}));

vi.mock('~/utils/login-helpers', () => ({
  getLoginLink: ({ returnUrl }: { returnUrl: string }) => `/login?returnUrl=${returnUrl}`,
}));

// Stub the heavy client-only imports the page module pulls at top so importing
// it in a node unit test doesn't drag a DOM in. The resolver (unit under test)
// touches none of them. `isAppReviewer` is left REAL (pure predicate) so the
// moderator gate is exercised for real.
vi.mock('@mantine/core', () => ({
  Button: () => null,
  Center: () => null,
  Loader: () => null,
}));
vi.mock('@tabler/icons-react', () => ({ IconArrowLeft: () => null }));
vi.mock('next/link', () => ({ default: () => null }));
vi.mock('~/components/AppLayout/NotFound', () => ({ NotFound: () => null }));
vi.mock('~/components/Apps/AppsPageLayout', () => ({ AppsPageLayout: () => null }));
vi.mock('~/components/Apps/OnsiteReviewModal', () => ({
  OnsiteReviewModalBody: () => null,
  OnsiteReviewModalTitle: () => null,
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true, appReviewPage: true }),
}));
vi.mock('~/utils/trpc', () => ({ trpc: { blocks: { getPublishRequest: { useQuery: () => ({}) } } } }));

function makeCtx(
  opts: {
    appBlocks?: boolean;
    appReviewPage?: boolean;
    user?: { isModerator?: boolean } | null;
    publishRequestId?: string | undefined;
    resolvedUrl?: string;
  } = {}
) {
  const {
    appBlocks = true,
    appReviewPage = true,
    user = { isModerator: true } as { isModerator?: boolean } | null,
    resolvedUrl = '/apps/review/pubreq_1',
  } = opts;
  // Read via `in` so an EXPLICIT `{ publishRequestId: undefined }` models a
  // missing route param (a destructuring default would wrongly re-apply the id).
  const publishRequestId = 'publishRequestId' in opts ? opts.publishRequestId : 'pubreq_1';
  return {
    features: { appBlocks, appReviewPage },
    session: user ? { user } : null,
    ctx: { params: { publishRequestId }, resolvedUrl },
  };
}

async function loadResolver() {
  await import('~/pages/apps/review/[publishRequestId]');
  if (!capturedResolver.fn) throw new Error('resolver not captured');
  return capturedResolver.fn;
}

describe('review detail page SSR — moderator + flag gate', () => {
  beforeEach(() => {
    // Only reset the service mock — NOT capturedResolver (ESM module cache means
    // createServerSideProps captures the resolver on the FIRST import only).
    mockResolveReviewRequestTarget.mockReset();
  });

  it('404s when the appBlocks flag is off', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ appBlocks: false }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewRequestTarget).not.toHaveBeenCalled();
  });

  it('404s when the appReviewPage flag is off (dark by default for a non-mod cohort)', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ appReviewPage: false }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewRequestTarget).not.toHaveBeenCalled();
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
    expect(mockResolveReviewRequestTarget).not.toHaveBeenCalled();
  });

  it('404s when the publishRequestId param is missing', async () => {
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: undefined }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewRequestTarget).not.toHaveBeenCalled();
  });

  it('404s when the request is missing / withdrawn (resolver returns null)', async () => {
    mockResolveReviewRequestTarget.mockResolvedValue(null);
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: 'pubreq_missing' }));
    expect(result).toEqual({ notFound: true });
    expect(mockResolveReviewRequestTarget).toHaveBeenCalledWith('pubreq_missing');
  });

  it('returns props with the resolved id for a valid moderator + reviewable request', async () => {
    mockResolveReviewRequestTarget.mockResolvedValue({ id: 'pubreq_1', status: 'pending' });
    const resolver = await loadResolver();
    const result = await resolver(makeCtx({ publishRequestId: 'pubreq_1' }));
    expect(result).toEqual({ props: { publishRequestId: 'pubreq_1' } });
  });
});
