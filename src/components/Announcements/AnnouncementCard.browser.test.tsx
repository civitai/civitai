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
// `impressions` passed.
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
    // 🔴 An anchor stays middle-, cmd-clickable and copyable — all routes around the
    // interstitial. The missing href IS the fix.
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

  test('an internal action also reports the click to analytics', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    const onActionClick = vi.fn();
    // A hash target, not a real path — see the comment on `action` in
    // announcement-tracking.browser.test.tsx: clicking a real path navigates the test
    // iframe and kills the run, silently, with the remaining tests left "skipped".
    const action = { link: '#offer', linkText: 'See the model' };
    renderWithProviders(
      <AnnouncementCard {...base} actions={[action]} onActionClick={onActionClick} />
    );

    await page.getByRole('link', { name: 'See the model' }).click();
    expect(onActionClick).toHaveBeenCalledWith(action, 0);
  });

  test('an external link in the body opens the interstitial', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    renderWithProviders(
      <AnnouncementCard {...base} content="grab them at [my telegram](https://t.me/SomeGroup)" />
    );

    const link = page.getByRole('link', { name: 'my telegram' });
    await expect.element(link).toBeVisible();
    await link.click();
    expect(mocks.openExternalLinkWarning).toHaveBeenCalledWith('https://t.me/SomeGroup');
  });

  test('an internal link in the body is left alone', async () => {
    const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
    // Hash target — see the comment above on the internal-action test.
    renderWithProviders(<AnnouncementCard {...base} content="see [my model](#offer)" />);

    const link = page.getByRole('link', { name: 'my model' });
    await expect.element(link).toHaveAttribute('href', '#offer');
    await link.click();
    expect(mocks.openExternalLinkWarning).not.toHaveBeenCalled();
  });
});

// 🔴 `warnOnExternalLinks` is opt-in, and every other surface — articles, comments, bios —
// depends on that. Dropping the `warnOnExternalLinks &&` conjunct in `CustomMarkdown` would
// put the interstitial in front of every external link in the app and pass every test above,
// because they all render the one caller that opts in. This is what pins the boundary.
describe('CustomMarkdown without warnOnExternalLinks', () => {
  beforeEach(() => {
    mocks.openExternalLinkWarning.mockClear();
  });

  test('leaves an external link alone', async () => {
    const { CustomMarkdown } = await import('~/components/Markdown/CustomMarkdown');
    // Nothing calls `preventDefault` on this path — that is the property under test — so the
    // click would really open `target="_blank"`. Swallowing the default keeps the run
    // deterministic; React still dispatches the component's own handler, if it has one.
    const swallowNavigation = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('click', swallowNavigation, true);
    try {
      renderWithProviders(
        <CustomMarkdown allowedElements={['a']} unwrapDisallowed>
          grab them at [my telegram](https://t.me/SomeGroup)
        </CustomMarkdown>
      );

      const link = page.getByRole('link', { name: 'my telegram' });
      // Asserted so a "not called" cannot come from the href being mangled into something
      // `isExternalHref` would have called internal anyway.
      await expect.element(link).toHaveAttribute('href', 'https://t.me/SomeGroup');
      await link.click();
      expect(mocks.openExternalLinkWarning).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('click', swallowNavigation, true);
    }
  });
});
