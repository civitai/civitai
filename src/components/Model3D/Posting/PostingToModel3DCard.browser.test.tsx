import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * PostingToModel3DCard — the "Posted to 3D Model" chip rendered by the image
 * viewers. This pins the DURABLE data-gate that eliminates the ambient
 * `model3d.getByPostId` call (~36/s, mostly null) on api-primary:
 *
 *   - `model3dId` is a NUMBER  → chip renders directly via `getById`; the
 *     `getByPostId` query is NOT enabled.
 *   - `model3dId` is `null`    → caller's payload already resolved "no visible
 *     Model3D" → chip renders nothing AND `getByPostId` is NOT enabled (this is
 *     the elimination: the image-detail viewers thread the visibility-checked
 *     `model3dId` from `image.get`, so the call never fires regardless of the
 *     `model3dFeed` feature flag — survives GA).
 *   - `model3dId` is `undefined` (no prop) → legacy fallback: `getByPostId` IS
 *     enabled (the feed-modal path that we intentionally don't enrich).
 *
 * tRPC is mocked via the scaffold's documented `vi.mock('~/utils/trpc')`
 * pattern; the mock records the `enabled` flag each `useQuery` is called with so
 * we can assert exactly which query path the component took.
 */

const mocks = vi.hoisted(() => ({
  // Records { enabled } for each query so the test can assert which fired.
  byPostIdCalls: [] as Array<{ postId: number; enabled: boolean }>,
  byIdCalls: [] as Array<{ id: number; enabled: boolean }>,
  // The card payloads each query returns when enabled.
  byPostIdData: null as null | { id: number; name: string; thumbnailImage: unknown },
  byIdData: null as null | { id: number; name: string; thumbnailImage: unknown },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    model3d: {
      getByPostId: {
        useQuery: (
          input: { postId: number },
          opts?: { enabled?: boolean }
        ) => {
          const enabled = opts?.enabled ?? true;
          mocks.byPostIdCalls.push({ postId: input.postId, enabled });
          return { data: enabled ? mocks.byPostIdData : undefined };
        },
      },
      getById: {
        useQuery: (input: { id: number }, opts?: { enabled?: boolean }) => {
          const enabled = opts?.enabled ?? true;
          mocks.byIdCalls.push({ id: input.id, enabled });
          return { data: enabled ? mocks.byIdData : undefined };
        },
      },
    },
  },
}));

// EdgeMedia pulls in edge-url/env machinery we don't need — stub to a plain img.
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));

// NextLink wraps next/link; render children inside a plain anchor so the chip's
// `legacyBehavior` passHref child renders network-free.
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { PostingToModel3DCard } = await import('./PostingToModel3DCard');

const enabledOf = (calls: Array<{ enabled: boolean }>) => calls.some((c) => c.enabled);

beforeEach(() => {
  mocks.byPostIdCalls = [];
  mocks.byIdCalls = [];
  mocks.byPostIdData = null;
  mocks.byIdData = null;
});

describe('PostingToModel3DCard — durable data-gate', () => {
  test('renders from the model3dId prop WITHOUT enabling getByPostId', async () => {
    mocks.byIdData = { id: 555, name: 'My Cube', thumbnailImage: null };

    renderWithProviders(<PostingToModel3DCard model3dId={555} postId={123} />);

    // Chip rendered the model name + links to the 3D model.
    await expect.element(page.getByText('My Cube')).toBeInTheDocument();
    const link = document.querySelector('a[href="/3d-models/555/my-cube"]');
    expect(link).not.toBeNull();

    // getById ran enabled; getByPostId was NOT enabled even though postId was passed.
    expect(enabledOf(mocks.byIdCalls)).toBe(true);
    expect(mocks.byIdCalls.some((c) => c.id === 555 && c.enabled)).toBe(true);
    expect(enabledOf(mocks.byPostIdCalls)).toBe(false);
  });

  test('model3dId=null renders nothing AND does NOT enable getByPostId (the elimination)', async () => {
    // Even if a stray getByPostId result existed, the resolved-absent null must
    // suppress both the query and any render.
    mocks.byPostIdData = { id: 999, name: 'Should Not Show', thumbnailImage: null };

    renderWithProviders(<PostingToModel3DCard model3dId={null} postId={123} />);

    // Nothing rendered (no chip link, no leaked name).
    expect(document.querySelector('a[href="/3d-models/999"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Should Not Show');

    // Neither query is enabled — this is the durable, flag-independent cut.
    expect(enabledOf(mocks.byPostIdCalls)).toBe(false);
    expect(enabledOf(mocks.byIdCalls)).toBe(false);
  });

  test('model3dId undefined falls back to the getByPostId lookup (legacy/feed path)', async () => {
    mocks.byPostIdData = { id: 777, name: 'Linked From Post', thumbnailImage: null };

    renderWithProviders(<PostingToModel3DCard postId={123} />);

    await expect.element(page.getByText('Linked From Post')).toBeInTheDocument();
    const link = document.querySelector('a[href="/3d-models/777/linked-from-post"]');
    expect(link).not.toBeNull();

    // The fallback path: getByPostId enabled, getById not.
    expect(mocks.byPostIdCalls.some((c) => c.postId === 123 && c.enabled)).toBe(true);
    expect(enabledOf(mocks.byIdCalls)).toBe(false);
  });

  test('model3dId=null with no postId renders nothing and issues no enabled query', async () => {
    renderWithProviders(<PostingToModel3DCard model3dId={null} />);
    // No card payload mocked → if anything rendered it'd have no href; assert the
    // gate instead: neither query enabled.
    expect(enabledOf(mocks.byPostIdCalls)).toBe(false);
    expect(enabledOf(mocks.byIdCalls)).toBe(false);
  });

  // FEED-MODAL path: an item opened from the feed/grid now carries the
  // visibility-checked `model3dId` from getAllImages / getAllImagesIndex (this
  // PR). The chip MUST render from that prop and MUST NOT fire the ambient
  // `getByPostId` — that is what makes the #2682 model3dFeed flag-gate redundant
  // on this path (it no longer protects an ambient call that doesn't fire).
  test('feed-modal item with a threaded model3dId renders via prop, no getByPostId', async () => {
    mocks.byIdData = { id: 4242, name: 'Feed Cube', thumbnailImage: null };
    // Mimic the leak-trap: a stale getByPostId result must never be read.
    mocks.byPostIdData = { id: 8888, name: 'LEAKED', thumbnailImage: null };

    renderWithProviders(
      <PostingToModel3DCard model3dId={4242} postId={321} label="Posted to 3D Model" />
    );

    await expect.element(page.getByText('Feed Cube')).toBeInTheDocument();
    expect(document.querySelector('a[href="/3d-models/4242/feed-cube"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('LEAKED');

    // getByPostId never enabled even though postId was passed → the ambient call
    // is eliminated on the feed-modal path, not merely flag-gated.
    expect(enabledOf(mocks.byPostIdCalls)).toBe(false);
    expect(mocks.byIdCalls.some((c) => c.id === 4242 && c.enabled)).toBe(true);
  });
});
