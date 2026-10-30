import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';
import type * as TrackUtils from '~/components/TrackView/track.utils';
import type * as UseTrackImpression from '~/components/TrackView/useTrackImpression';

/**
 * Announcement analytics is CREATOR-ONLY, and the sitewide rows render through the same
 * `AnnouncementCard`. So the assertion that carries this feature is the NEGATIVE one: a
 * platform announcement must record nothing. A test that only checks the creator card emits
 * passes just as happily on an unconditional hook that instruments all 317 platform rows.
 */

const trackAction = vi.fn(() => Promise.resolve());
const trackImpression = vi.fn();
// The ref the fake hands back, kept so a test can assert it reached a DOM node. Asserting the
// hook's ARGUMENT alone would stay green if the card stopped attaching the ref, which records
// nothing forever — the real hook only ever observes `ref.current`.
let impressionRef: { current: HTMLElement | null } = { current: null };

vi.mock('~/components/TrackView/track.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackUtils>()),
  useTrackEvent: () => ({ trackAction, trackSearch: vi.fn(), trackShare: vi.fn() }),
}));

// Spied rather than left real: the real hook needs an IntersectionObserver to fire and a
// second of dwell, so asserting on it would be asserting on the observer's timing. What is
// under test here is WHICH entities each surface registers, which is this argument.
vi.mock('~/components/TrackView/useTrackImpression', async (importOriginal) => ({
  ...(await importOriginal<typeof UseTrackImpression>()),
  useTrackImpression: (targets: unknown) => {
    trackImpression(targets);
    return impressionRef;
  },
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
  useFeatureFlags: () => ({ canViewNsfw: false, feedImpressions: true }),
}));

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  const stubbed: Record<string, unknown> = {
    user: { getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) } },
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

// A hash link, not a real path. Clicking a path navigates the test iframe, which kills the
// run — and vitest reports that as `success: true` with the remaining tests "pending", so a
// green summary would be hiding the two assertions this file exists for. A hash click still
// dispatches the same event through the same handler without a reload.
const action = { link: '#offer', linkText: 'Go look' };

const creatorAnnouncement = {
  id: 2,
  title: 'Creator says hello',
  content: 'new lora dropping',
  color: 'blue',
  emoji: null,
  metadata: { actions: [action] },
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
} as any;

const platformAnnouncement = {
  id: 7,
  title: 'Civitai says hello',
  content: 'new lora dropping',
  color: 'blue',
  metadata: { actions: [action], type: 'site' },
} as any;

function resetSpies() {
  trackImpression.mockClear();
  trackAction.mockClear();
  impressionRef = { current: null };
}

async function renderCreator(withAuthor = true) {
  const { CreatorAnnouncement } = await import('~/components/Announcements/CreatorAnnouncement');
  renderWithProviders(
    <CreatorAnnouncement announcement={creatorAnnouncement} withAuthor={withAuthor} />
  );
  await expect.element(page.getByText('new lora dropping')).toBeInTheDocument();
}

async function renderPlatform() {
  const { Announcement } = await import('~/components/Announcements/Announcement');
  renderWithProviders(<Announcement announcement={platformAnnouncement} />);
  await expect.element(page.getByText('new lora dropping')).toBeInTheDocument();
}

describe('announcement analytics is creator-only', () => {
  test('a creator announcement registers itself for an impression, on a real element', async () => {
    resetSpies();
    await renderCreator();

    expect(trackImpression).toHaveBeenCalledWith([{ entityType: 'Announcement', entityId: 2 }]);
    // The ref has to LAND. Without this, deleting the card's `ref=` leaves every assertion
    // above green while production records nothing at all.
    expect(impressionRef.current).toBeInstanceOf(HTMLElement);
  });

  test('a creator announcement records a click on its link, once, naming both ids', async () => {
    resetSpies();
    await renderCreator();

    await page.getByRole('link', { name: 'Go look' }).click();

    expect(trackAction).toHaveBeenCalledWith({
      type: 'Announcement_Click',
      details: { announcementId: 2, creatorId: 99 },
    });
    // Count as well as shape: two handlers firing one event doubles a number a creator reads.
    expect(trackAction).toHaveBeenCalledTimes(1);
  });

  // The card has TWO roots — `withAuthor` picks the stacked one, the profile carousel renders
  // the other — and each attaches the ref itself. Asserting only the byline shape left the
  // carousel's root free to lose its ref and record nothing, with every test still green.
  test('the profile-carousel shape attaches the ref too', async () => {
    resetSpies();
    await renderCreator(false);

    expect(trackImpression).toHaveBeenCalledWith([{ entityType: 'Announcement', entityId: 2 }]);
    expect(impressionRef.current).toBeInstanceOf(HTMLElement);
  });

  // 🔴 The whole point. Remove the branch and this is the test that goes red.
  test('a sitewide announcement records nothing — no impression, no click', async () => {
    resetSpies();
    await renderPlatform();

    await page.getByRole('link', { name: 'Go look' }).click();

    // The hook IS called by the shared card — with nothing to record, which is what disables
    // it. So the assertion is on the entities, not on the call: a platform card must never
    // register an entity.
    expect(trackImpression.mock.calls.flatMap(([targets]) => targets ?? [])).toEqual([]);
    expect(trackAction).not.toHaveBeenCalled();
  });
});
