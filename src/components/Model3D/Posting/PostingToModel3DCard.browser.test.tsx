import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * "Posted/Posting to 3D Model" chip — guards the ambient-call cut.
 *
 * The image viewers render this chip on EVERY image view via `postId`, which
 * used to fire `model3d.getByPostId` per view. That call is Flipt-gated
 * (`model3dFeed`, availability ['mod']) and returns null for the vast majority
 * of posts, so it was ~36 req/s of mostly-wasted full-middleware cycles on
 * api-primary. The fix gates the client call on the SAME `features.model3dFeed`
 * flag. These tests pin the load-bearing behaviour:
 *
 *   1. Flag OFF (non-mod): the postId lookup is NOT enabled (never fires) and
 *      the chip renders nothing.
 *   2. Flag ON + the post HAS a linked Model3D: the lookup fires and the chip
 *      renders (real 3D posts still show it).
 *   3. Flag ON + the post has NO linked Model3D (query returns null): chip
 *      renders nothing.
 */

const mocks = vi.hoisted(() => ({
  // Captures the `enabled` flag the component passes to getByPostId so we can
  // assert the call is suppressed when the feature flag is off.
  byPostEnabled: undefined as boolean | undefined,
  byPostData: null as null | { id: number; name: string; thumbnailImage: null },
  model3dFeed: false,
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    model3d: {
      getByPostId: {
        useQuery: (_input: unknown, opts?: { enabled?: boolean }) => {
          mocks.byPostEnabled = opts?.enabled;
          // Mirror react-query: a disabled query yields no data.
          return { data: opts?.enabled ? mocks.byPostData : undefined };
        },
      },
      getById: {
        useQuery: () => ({ data: undefined }),
      },
    },
  },
}));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ model3dFeed: mocks.model3dFeed }),
}));

// EdgeMedia/NextLink pull in edge-url + routing machinery not under test.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ alt }: { alt?: string }) => <span>{alt}</span>,
}));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={typeof href === 'string' ? href : '#'}>{children}</a>
  ),
}));

const { PostingToModel3DCard } = await import('./PostingToModel3DCard');

beforeEach(() => {
  mocks.byPostEnabled = undefined;
  mocks.byPostData = null;
  mocks.model3dFeed = false;
});

describe('PostingToModel3DCard', () => {
  test('flag OFF: does not fire the postId lookup and renders nothing', async () => {
    mocks.model3dFeed = false;
    // Even though the server WOULD resolve a Model3D for this post, the call is
    // suppressed client-side because the viewer can't see the 3D feature.
    mocks.byPostData = { id: 5, name: 'My 3D Model', thumbnailImage: null };

    renderWithProviders(<PostingToModel3DCard postId={123} label="Posted to 3D Model" />);

    // vitest-browser-react commits asynchronously; wait for the component to
    // run its hooks, then assert the query was passed `enabled: false`.
    await vi.waitFor(() => expect(mocks.byPostEnabled).toBe(false));
    // No chip (the flag-off query yields no data) — nothing in the document.
    expect(document.body.textContent).not.toContain('My 3D Model');
    expect(document.querySelector('a[href^="/3d-models/"]')).toBeNull();
  });

  test('flag ON + post linked to a Model3D: lookup fires and chip renders', async () => {
    mocks.model3dFeed = true;
    mocks.byPostData = { id: 5, name: 'My 3D Model', thumbnailImage: null };

    renderWithProviders(<PostingToModel3DCard postId={123} label="Posted to 3D Model" />);

    await vi.waitFor(() => expect(mocks.byPostEnabled).toBe(true));
    await expect.element(page.getByText('My 3D Model')).toBeInTheDocument();
    await expect.element(page.getByText('Posted to 3D Model')).toBeInTheDocument();
    // Links to the resolved 3D model detail page.
    await expect.element(page.getByRole('link')).toHaveAttribute('href', '/3d-models/5');
  });

  test('flag ON + post NOT linked (lookup returns null): renders nothing', async () => {
    mocks.model3dFeed = true;
    mocks.byPostData = null;

    renderWithProviders(<PostingToModel3DCard postId={123} label="Posted to 3D Model" />);

    await vi.waitFor(() => expect(mocks.byPostEnabled).toBe(true));
    expect(document.querySelector('a[href^="/3d-models/"]')).toBeNull();
  });
});
