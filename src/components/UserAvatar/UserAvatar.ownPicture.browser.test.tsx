import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup } from 'vitest-browser-react';
import { renderWithProviders } from '../../../test/geometry-setup';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as TrpcModule from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * Whose profile picture a viewer sees. The owner always sees their own on the NSFW-capable site
 * (.red), whatever its rating; everyone else is still held to their browsing level; a Blocked picture
 * is hidden from all; the SFW site (.com) keeps its gate, owner included.
 */
const mocks = vi.hoisted(() => ({
  viewerId: 1 as number | null,
  canViewNsfw: true,
  browsingLevel: 3, // PG | PG13
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.viewerId == null ? null : { id: mocks.viewerId }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({ canViewNsfw: mocks.canViewNsfw }),
}));
vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useViewerBrowsingLevelDebounced: () => mocks.browsingLevel,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'user.getById': { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
  }),
}));
vi.mock('~/client-utils/cf-images-utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useGetEdgeUrl: () => undefined,
}));
// The picture itself is a marker; its own blur/guard logic is not under test.
vi.mock('~/components/UserAvatar/UserAvatarProfilePicture', () => ({
  UserAvatarProfilePicture: () => <div data-testid="profile-picture" />,
}));
vi.mock('~/components/UserAvatar/UserHoverCard', () => ({
  UserHoverCard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { UserAvatar } = await import('~/components/UserAvatar/UserAvatar');

const NSFW_XXX = 16;
const BLOCKED = 32;

function renderAvatar(picture: {
  nsfwLevel: number;
  ingestion?: string;
  needsReview?: string | null;
  tosViolation?: boolean;
}) {
  const user = {
    id: 1,
    username: 'tester',
    image: null,
    deletedAt: null,
    cosmetics: [],
    profilePicture: {
      id: 10,
      url: 'abc',
      type: 'image',
      ingestion: 'Scanned',
      needsReview: null,
      tosViolation: false,
      ...picture,
    },
  } as unknown as React.ComponentProps<typeof UserAvatar>['user'];
  return renderWithProviders(<UserAvatar user={user} size="lg" />);
}

const picture = () => document.querySelector('[data-testid="profile-picture"]');

afterEach(() => {
  cleanup();
  mocks.viewerId = 1;
  mocks.canViewNsfw = true;
  mocks.browsingLevel = 3;
});

describe('UserAvatar own profile picture', () => {
  test('owner on .red sees their picture even when its rating is outside their browsing level', async () => {
    renderAvatar({ nsfwLevel: NSFW_XXX });
    await expect.poll(picture).not.toBeNull();
  });

  test('another viewer on .red still gets initials for the same picture', async () => {
    mocks.viewerId = 2;
    renderAvatar({ nsfwLevel: NSFW_XXX });
    await expect.poll(() => document.body.textContent).toContain('TE');
    expect(picture()).toBeNull();
  });

  test('a Blocked picture stays hidden, owner included', async () => {
    renderAvatar({ nsfwLevel: BLOCKED, ingestion: 'Blocked' });
    await expect.poll(() => document.body.textContent).toContain('TE');
    expect(picture()).toBeNull();
  });

  test('on the SFW site (.com) an out-of-level picture stays hidden from its owner', async () => {
    mocks.canViewNsfw = false;
    renderAvatar({ nsfwLevel: NSFW_XXX });
    await expect.poll(() => document.body.textContent).toContain('TE');
    expect(picture()).toBeNull();
  });

  test('an in-level picture still shows to the owner (the check can pass for the right reason)', async () => {
    renderAvatar({ nsfwLevel: 1 });
    await expect.poll(picture).not.toBeNull();
  });

  test('a picture mods removed (tosViolation) stays hidden from its owner on .red', async () => {
    renderAvatar({ nsfwLevel: NSFW_XXX, tosViolation: true });
    await expect.poll(() => document.body.textContent).toContain('TE');
    expect(picture()).toBeNull();
  });

  test('a picture held for review (needsReview) stays hidden from its owner on .red', async () => {
    renderAvatar({ nsfwLevel: NSFW_XXX, needsReview: 'minor' });
    await expect.poll(() => document.body.textContent).toContain('TE');
    expect(picture()).toBeNull();
  });
});
