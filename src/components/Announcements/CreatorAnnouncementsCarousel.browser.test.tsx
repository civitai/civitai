import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as CreatorUtils from '~/components/Announcements/creator-announcements.utils';
import type * as ReportTrigger from '~/components/Dialog/triggers/report';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';

/**
 * Report must be reachable from the profile carousel, not only from the panel — which requires
 * following the creator first.
 */

const mocks = vi.hoisted(() => ({
  announcements: [] as any[],
  openReportModal: vi.fn(),
}));

vi.mock('~/components/Announcements/creator-announcements.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorUtils>()),
  useCreatorAnnouncementsFeature: () => true,
  useQueryCreatorAnnouncements: () => ({ announcements: mocks.announcements, isLoading: false }),
  useMutedCreators: () => [],
  useDeleteCreatorAnnouncement: () => ({ deleteAnnouncement: vi.fn(), isLoading: false }),
  useToggleAnnouncementMute: () => ({ toggle: vi.fn(), isLoading: false }),
}));

vi.mock('~/components/Dialog/triggers/report', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportTrigger>()),
  openReportModal: mocks.openReportModal,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientProvider>()),
  useIsClient: () => true,
}));

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

// A STUB tRPC client, not a narrowed real one — `trpc` is a flat Proxy whose ownKeys is empty, so
// spreading the real module yields `{}`. The Proxy turns anything unnamed into a named error
// instead of `Cannot read properties of undefined` inside a render.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const stubbed: Record<string, unknown> = {
    user: { getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) } },
    track: { trackShare: { useMutation: () => ({ mutateAsync: async () => undefined }) } },
  };
  return {
    ...actual,
    trpc: new Proxy(stubbed, {
      get(target, prop: string) {
        if (Object.hasOwn(target, prop)) return target[prop];
        throw new Error(`Unmocked tRPC router in a component test: trpc.${String(prop)}`);
      },
    }),
  };
});

const announcement = {
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

async function renderCarousel() {
  const { CreatorAnnouncementsCarousel } = await import(
    '~/components/Announcements/CreatorAnnouncementsCarousel'
  );
  renderWithProviders(<CreatorAnnouncementsCarousel userId={99} />);
}

describe('CreatorAnnouncementsCarousel options menu', () => {
  beforeEach(() => {
    mocks.announcements = [announcement];
    mocks.openReportModal.mockClear();
  });

  test("offers Report on another creator's announcement", async () => {
    await renderCarousel();

    await page.getByRole('button', { name: 'Announcement options' }).click();
    const report = page.getByRole('menuitem', { name: 'Report announcement' });
    await expect.element(report).toBeVisible();

    // `ReportMenuItem` wraps in `LoginRedirect`, which gates the callback on the global
    // `window.isAuthed` rather than on the mocked `useCurrentUser()`.
    try {
      window.isAuthed = true;
      await report.click();
      expect(mocks.openReportModal).toHaveBeenCalledWith({
        entityType: 'announcement',
        entityId: 2,
      });
    } finally {
      window.isAuthed = undefined;
    }
  });

  test('does not offer Report on your own announcement', async () => {
    mocks.announcements = [{ ...announcement, userId: 1, user: { ...announcement.user, id: 1 } }];
    await renderCarousel();

    await page.getByRole('button', { name: 'Announcement options' }).click();
    // Assert on a sibling that IS expected, so this cannot pass by the menu never rendering.
    await expect.element(page.getByRole('menuitem', { name: /Delete announcement/ })).toBeVisible();
    await expect
      .element(page.getByRole('menuitem', { name: 'Report announcement' }))
      .not.toBeInTheDocument();
  });
});
