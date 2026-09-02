import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as BrowsingLevelProvider from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type * as Trpc from '~/utils/trpc';

/**
 * The byline is OFF by default and the surface turns it on.
 *
 * 🔴 Do not "simplify" this by making the byline unconditional. It is deliberately absent
 * on the author's own profile, where every card on the page is already theirs, and present
 * in the notifications panel, where creator and Civitai cards are interleaved in one list
 * and a reader has no other way to tell an announcement is not from Civitai. That second
 * case is an impersonation surface, not a missing nicety.
 */

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
  useFeatureFlags: () => ({ canViewNsfw: false }),
}));

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => false,
}));

vi.mock('~/components/BrowsingLevel/BrowsingLevelProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowsingLevelProvider>()),
  useViewerBrowsingLevelDebounced: () => 1,
}));

// `UserAvatar` calls `trpc.user.getById.useQuery` even when it is handed a user (the query
// is disabled, the hook still runs), and this scaffold mounts no tRPC provider. Only that
// one procedure is replaced; the rest of the module is the real one.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: {
      ...actual.trpc,
      user: {
        ...(actual.trpc as any).user,
        getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
      },
    },
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
} as any;

async function renderCard(withAuthor: boolean) {
  const { CreatorAnnouncement } = await import('~/components/Announcements/CreatorAnnouncement');
  renderWithProviders(<CreatorAnnouncement announcement={announcement} withAuthor={withAuthor} />);
}

/**
 * The card root, found from content the card definitely rendered. Awaits that content
 * first: the render is committed asynchronously, so reading the DOM straight after
 * `renderCard` sees an empty body and fails for a reason that has nothing to do with the
 * layout under test.
 */
async function cardRoot() {
  await expect.element(page.getByText('new lora dropping')).toBeInTheDocument();
  const el = page.getByText('new lora dropping').element().closest('.rounded-md');
  if (!el) throw new Error('no card root found — the card did not render');
  return el;
}

describe('CreatorAnnouncement attribution', () => {
  test('withAuthor renders the creator name and a profile link in the top bar', async () => {
    await renderCard(true);

    await expect.element(page.getByText('someone')).toBeInTheDocument();

    // The href exactly, not a name match: `getByRole('link', { name })` matches as a
    // SUBSTRING, so it would pass against a link pointing anywhere.
    const links = page.getByRole('link').elements();
    const hrefs = links.map((el) => el.getAttribute('href'));
    expect(hrefs).toContain('/user/someone');
  });

  // The sitewide Civitai card renders through the same `AnnouncementCard` with no top bar.
  // `flex-col` is what the top-bar path adds to the card root, so its absence is the
  // structural proof that path is not taken — no stylesheet needed to read it.
  test('the no-top-bar path leaves the card a row, as the sitewide card has always been', async () => {
    await renderCard(false);

    expect((await cardRoot()).classList.contains('flex-col')).toBe(false);
  });

  test('withAuthor stacks the card so the top bar spans it', async () => {
    await renderCard(true);

    expect((await cardRoot()).classList.contains('flex-col')).toBe(true);
  });

  test('without withAuthor there is no byline — the profile surface renders this shape', async () => {
    await renderCard(false);

    await expect.element(page.getByText('Creator says hello')).toBeInTheDocument();
    expect(page.getByText('someone').elements()).toHaveLength(0);
  });
});
