import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as IsClientProvider from '~/providers/IsClientProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';

const mocks = vi.hoisted(() => ({ openExternalLinkWarning: vi.fn() }));

vi.mock('~/components/ExternalLinkWarning/openExternalLinkWarning', () => ({
  openExternalLinkWarning: mocks.openExternalLinkWarning,
}));

// `CustomMarkdown` reads both of these, and the scaffold mounts neither provider.
// `useCurrentUser` goes through `useCivitaiSessionContext`, which throws on a missing
// context — a throw during render empties the tree and turns every assertion into a timeout.
vi.mock('~/providers/IsClientProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof IsClientProvider>()),
  useIsClient: () => true,
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => ({ id: 1, isModerator: false }),
}));

// `useTrackImpression` calls `useFeatureFlags()` unconditionally, even with no
// `impressions` passed — same reason it's mocked in the sibling Announcement suites.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({}),
}));

const base = { title: 'Hello', content: 'body text', color: 'blue' as const };

describe('AnnouncementCard actions', () => {
  beforeEach(() => {
    mocks.openExternalLinkWarning.mockClear();
  });

  test('an internal action renders an anchor that navigates directly', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    renderWithProviders(
      <AnnouncementCard {...base} actions={[{ link: '/models/123', linkText: 'See the model' }]} />
    );

    const cta = page.getByRole('link', { name: 'See the model' });
    await expect.element(cta).toHaveAttribute('href', '/models/123');
  });

  test('an external action opens the interstitial instead of navigating', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    renderWithProviders(
      <AnnouncementCard
        {...base}
        actions={[{ link: 'https://t.me/SomeGroup', linkText: 'Join the group' }]}
      />
    );

    const cta = page.getByRole('button', { name: 'Join the group' });
    await expect.element(cta).toBeVisible();
    // 🔴 The absence of an href is the fix, not a detail. An anchor stays middle-clickable,
    // cmd-clickable and copyable — all of which route around the interstitial.
    await expect.element(cta).not.toHaveAttribute('href');

    await cta.click();
    expect(mocks.openExternalLinkWarning).toHaveBeenCalledWith('https://t.me/SomeGroup');
  });

  test('an external action still reports the click to analytics', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    const onActionClick = vi.fn();
    const action = { link: 'https://t.me/SomeGroup', linkText: 'Join the group' };
    renderWithProviders(
      <AnnouncementCard {...base} actions={[action]} onActionClick={onActionClick} />
    );

    await page.getByRole('button', { name: 'Join the group' }).click();
    expect(onActionClick).toHaveBeenCalledWith(action, 0);
  });
});
