import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
import { renderWithProviders } from '../../../test/component-setup';
import type * as AnnouncementsUtils from '~/components/Announcements/announcements.utils';
import type * as CreatorUtils from '~/components/Announcements/creator-announcements.utils';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';
import {
  CREATOR_ANNOUNCEMENTS_DISMISSED_KEY,
  pruneDismissedCreatorAnnouncements,
} from '~/components/Announcements/creator-announcement-dismissals';

/**
 * The chips decide which SOURCE renders, and both are on by default. The failure this
 * pins is a chip that filters nothing: with `creators` off, a followed creator's
 * announcement must be absent from the panel, not merely styled differently.
 */

const mocks = vi.hoisted(() => ({
  civitai: [] as any[],
  creators: [] as any[],
  featureEnabled: true,
}));

vi.mock('~/components/Announcements/announcements.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof AnnouncementsUtils>()),
  useGetAnnouncements: () => ({ data: mocks.civitai, isLoading: false }),
}));

vi.mock('~/components/Announcements/creator-announcements.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorUtils>()),
  useCreatorAnnouncementsFeature: () => mocks.featureEnabled,
  useQueryFollowedAnnouncements: (enabled = true) => ({
    announcements: enabled && mocks.featureEnabled ? mocks.creators : [],
    isLoading: false,
  }),
  useMutedCreators: () => [],
  useDeleteCreatorAnnouncement: () => ({ deleteAnnouncement: vi.fn(), isLoading: false }),
}));

// The panel's leaves read providers `renderWithProviders` does not mount: `useCurrentUser`
// (delete control) and `useIsClient` (CustomMarkdown, DaysFromNow). Both throw on a missing
// context, which empties the tree and turns every assertion into a timeout.
vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientProvider>()),
  useIsClient: () => true,
}));

// The byline's avatar reads three more providers this scaffold does not mount.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({ canViewNsfw: false, creatorAnnouncements: true }),
}));

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));

// A STUB tRPC client, not a narrowed real one. `trpc` is a tRPC flat Proxy, and spreading a
// Proxy reads ownKeys — which is empty — so `{...actual.trpc}` yields `{}`. Anything not
// named here is absent by construction; the Proxy below turns that into a named error
// instead of `Cannot read properties of undefined` inside a render, which empties the tree
// and makes every assertion in the file time out with nothing pointing at tRPC.
//
// `UserAvatar` calls `trpc.user.getById.useQuery` even when handed a complete user (the
// query is disabled, the hook still runs), and this scaffold mounts no tRPC provider.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const stubbed: Record<string, unknown> = {
    user: { getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) } },
  };
  return {
    ...actual,
    trpc: new Proxy(stubbed, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        throw new Error(`Unmocked tRPC router in a component test: trpc.${String(prop)}`);
      },
    }),
  };
});

const civitaiAnnouncement = {
  id: 1,
  title: 'Civitai says hello',
  content: 'platform news',
  color: 'blue',
  emoji: null,
  metadata: {},
  startsAt: new Date(),
  endsAt: null,
  dismissed: false,
  createdAt: new Date(),
};

const creatorAnnouncement = {
  id: 2,
  title: 'Creator says hello',
  content: 'new lora dropping',
  color: 'blue',
  emoji: null,
  metadata: {},
  startsAt: new Date(),
  endsAt: null,
  createdAt: new Date(),
  userId: 99,
  nsfwLevel: 1,
  cover: null,
  user: {
    id: 99,
    username: 'someone',
    image: null,
    deletedAt: null,
    cosmetics: [],
    profilePicture: null,
  },
};

async function renderPanel(sources: Array<'civitai' | 'creators'>) {
  const { AnnouncementsPanel } = await import('~/components/Announcements/AnnouncementsPanel');
  renderWithProviders(<AnnouncementsPanel sources={sources} />);
}

describe('AnnouncementsPanel', () => {
  beforeEach(() => {
    mocks.civitai = [civitaiAnnouncement];
    mocks.creators = [creatorAnnouncement];
    mocks.featureEnabled = true;
    // The dismissal store is module-scope and reads localStorage ONCE, at import. In browser
    // mode the module is not re-evaluated between tests — `vi.resetModules()` does not do it,
    // measured: moving the dismissal test to run first made four later tests fail on a leaked
    // dismissal. Pruning against an empty live set clears the set through the store's own
    // API, which is the only thing that actually resets it. The localStorage key goes too, so
    // a fresh import in some later run does not read a stale set back.
    pruneDismissedCreatorAnnouncements([]);
    window.localStorage.removeItem(CREATOR_ANNOUNCEMENTS_DISMISSED_KEY);
  });

  test('both chips on renders both sources', async () => {
    await renderPanel(['civitai', 'creators']);

    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();
    await expect.element(page.getByText('Creator says hello')).toBeInTheDocument();
  });

  test('creators chip off removes creator announcements from the panel', async () => {
    await renderPanel(['civitai']);

    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();
    expect(page.getByText('Creator says hello').elements()).toHaveLength(0);
  });

  test('civitai chip off removes platform announcements from the panel', async () => {
    await renderPanel(['creators']);

    await expect.element(page.getByText('Creator says hello')).toBeInTheDocument();
    expect(page.getByText('Civitai says hello').elements()).toHaveLength(0);
  });

  test('flag off hides creator announcements even with the chip on', async () => {
    mocks.featureEnabled = false;
    await renderPanel(['civitai', 'creators']);

    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();
    expect(page.getByText('Creator says hello').elements()).toHaveLength(0);
  });

  test('no announcements from either source shows the empty state', async () => {
    mocks.civitai = [];
    mocks.creators = [];
    await renderPanel(['civitai', 'creators']);

    await expect.element(page.getByText('All caught up! Nothing to see here')).toBeInTheDocument();
  });

  test('a creator announcement in the panel names its author and is marked as a creator post', async () => {
    await renderPanel(['civitai', 'creators']);

    await expect.element(page.getByText('someone')).toBeInTheDocument();

    // The href exactly, not a role-name match: a name matches as a SUBSTRING, so that
    // assertion passes against a link pointing anywhere.
    const hrefs = page
      .getByRole('link')
      .elements()
      .map((el) => el.getAttribute('href'));
    expect(hrefs).toContain('/user/someone');
  });

  // BOTH sources render, and the assertion is scoped to the Civitai card's own subtree.
  // Rendering only `['civitai']` would pass with the whole feature deleted — the creator
  // card simply would not be on screen — which is a different fact than the one under test.
  test('a civitai announcement carries no creator byline while a creator one does', async () => {
    await renderPanel(['civitai', 'creators']);
    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();

    const civitaiCard = page.getByText('Civitai says hello').element().closest('.rounded-md');
    const creatorCard = page.getByText('Creator says hello').element().closest('.rounded-md');
    if (!civitaiCard || !creatorCard) throw new Error('both cards should have rendered');

    expect(civitaiCard.querySelector('a[href="/user/someone"]')).toBeNull();
    expect(civitaiCard.classList.contains('flex-col')).toBe(false);
    // The positive half, in the same list: whatever distinguishes them has to be present on
    // one card and absent on the other, or "absent here" means nothing.
    expect(creatorCard.querySelector('a[href="/user/someone"]')).not.toBeNull();
    expect(creatorCard.classList.contains('flex-col')).toBe(true);
  });

  test('dismissing a creator announcement removes it and leaves the civitai one', async () => {
    await renderPanel(['civitai', 'creators']);
    await expect.element(page.getByText('Creator says hello')).toBeInTheDocument();

    await page.getByRole('button', { name: 'Dismiss creator announcement' }).click();

    await expect.element(page.getByText('Creator says hello')).not.toBeInTheDocument();
    // The control: dismissal is targeted, not a panel-wide clear.
    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();
  });

  // The prune's whole contract is the early return on an empty live set: `pruneDismissals`
  // cannot tell "nothing is live" from "nothing has loaded", so pruning against an empty
  // load would drop every dismissal the user has made. Deleting that guard, or the effect,
  // makes this test fail — the card comes back.
  test('a load with no creator announcements does not resurrect a dismissal', async () => {
    await renderPanel(['civitai', 'creators']);
    await page.getByRole('button', { name: 'Dismiss creator announcement' }).click();
    await expect.element(page.getByText('Creator says hello')).not.toBeInTheDocument();

    cleanup();
    mocks.creators = [];
    await renderPanel(['civitai', 'creators']);
    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();

    cleanup();
    mocks.creators = [creatorAnnouncement];
    await renderPanel(['civitai', 'creators']);
    await expect.element(page.getByText('Civitai says hello')).toBeInTheDocument();
    expect(page.getByText('Creator says hello').elements()).toHaveLength(0);
  });
});
