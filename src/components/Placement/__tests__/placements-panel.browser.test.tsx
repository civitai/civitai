import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The unified placements page — the shell only.
 *
 * Stickers and remixes were two pages doing the same job on the same table.
 * This one holds both, and everything new lives in the shell: which surface you
 * are on, that it comes from and goes back to the URL, and the received counts
 * on the control. The two queues underneath are the existing components,
 * unchanged and stubbed here — a test that re-asserted their rows would be
 * testing code this change did not touch.
 *
 * The counts are the part worth pinning. They are what tells a creator there is
 * anything to review at all, and they come from a payload key that a click on
 * "mark all as read" once wiped for the whole session.
 */

const { sticker, remix, viewer } = vi.hoisted(() => ({
  sticker: { value: 0 },
  remix: { value: 0 },
  viewer: { username: 'zippy' as string | null, stickerBook: true },
}));

// `next/router` is stubbed by the shared harness (test/component-setup), and a
// setup-file mock wins over one declared here — mocking it again in this file
// silently did nothing, and the tests that read the URL passed anyway because
// the fallback they land on is the same surface the default renders. Drive the
// harness's singleton instead.
import { useRouter } from 'next/router';
vi.mock('~/components/Notifications/notifications.utils', () => ({
  useQueryNotificationsCount: () => ({
    pendingStickerPlacements: sticker.value,
    pendingRemixSubmissions: remix.value,
  }),
}));
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (viewer.username ? { id: 7, username: viewer.username } : null),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickerBook: viewer.stickerBook }),
}));
vi.mock('~/components/Placement/StickerPlacementQueue', () => ({
  StickerPlacementQueue: () => <div>sticker queue</div>,
}));
vi.mock('~/components/Placement/RemixSubmissionQueue', () => ({
  RemixSubmissionQueue: () => <div>remix queue</div>,
}));

import { PlacementsPanel as Placements } from '~/components/Placement/PlacementsPanel';

beforeEach(() => {
  vi.clearAllMocks();
  useRouter().query = {};
  sticker.value = 0;
  remix.value = 0;
  viewer.username = 'zippy';
  viewer.stickerBook = true;
});

describe('which queue is on screen', () => {
  test('opens on stickers when the URL says nothing', async () => {
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('sticker queue')).toBeInTheDocument();
    expect(page.getByText('remix queue').elements()).toHaveLength(0);
  });

  test('opens on remixes when the URL says so', async () => {
    // The whole point of the query param: a notification links straight to the
    // surface it is about, rather than to the one that happens to be first.
    useRouter().query = { type: 'remix' };
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('remix queue')).toBeInTheDocument();
    expect(page.getByText('sticker queue').elements()).toHaveLength(0);
  });

  test('falls back to stickers on a value it does not recognise', async () => {
    // A hand-edited or stale URL should open the page, not an error.
    useRouter().query = { type: 'banana' };
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('sticker queue')).toBeInTheDocument();
  });

  test('switching writes the surface to the URL', async () => {
    renderWithProviders(<Placements />);

    await userEvent.click(page.getByText('Remixes'));

    // Shallow replace, not a push: flipping between two views of your own queue
    // should not build a back-button trail.
    expect(useRouter().replace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ type: 'remix' }) }),
      undefined,
      { shallow: true }
    );
  });
});

describe('the counts on the control', () => {
  test('shows each surface its own number', async () => {
    sticker.value = 96;
    remix.value = 46;
    renderWithProviders(<Placements />);

    // Both visible at once, without switching — that is what the control is
    // for: "is there anything for me" answered in one look.
    await expect.element(page.getByText('96')).toBeInTheDocument();
    await expect.element(page.getByText('46')).toBeInTheDocument();
  });

  test('shows no badge for a surface with nothing waiting', async () => {
    sticker.value = 5;
    remix.value = 0;
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('5')).toBeInTheDocument();
    // A "0" disc reads as a broken badge rather than an empty queue.
    expect(page.getByText('0').elements()).toHaveLength(0);
  });

  test('caps a very large count rather than stretching the control', async () => {
    sticker.value = 1200;
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('99+')).toBeInTheDocument();
  });
});

describe('the way out to the sticker book', () => {
  // The queue is reached from a notification and every row on it is about a
  // sticker, but nothing on the page reached the book those stickers live in.
  const bookLink = () => page.getByRole('link', { name: 'Your sticker book' });

  test("points at the viewer's own book", async () => {
    renderWithProviders(<Placements />);

    // The href, read exactly. A `name` locator matches as a SUBSTRING, so a
    // link that merely EXISTS proves nothing about where it goes — and the
    // failure this guards is a book URL built from the wrong username.
    await expect.element(bookLink()).toHaveAttribute('href', '/user/zippy/sticker-book');
  });

  test('is gone on the remix surface', async () => {
    // Remixes have no sticker book behind them.
    useRouter().query = { type: 'remix' };
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('remix queue')).toBeInTheDocument();
    expect(bookLink().elements()).toHaveLength(0);
  });

  test('is gone when the sticker book is not enabled for this viewer', async () => {
    // The route redirects a flag-less viewer straight back off it, so a link
    // shown here would be a link to nowhere.
    viewer.stickerBook = false;
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('sticker queue')).toBeInTheDocument();
    expect(bookLink().elements()).toHaveLength(0);
  });

  test('is gone when there is no signed-in username to build it from', async () => {
    viewer.username = null;
    renderWithProviders(<Placements />);

    await expect.element(page.getByText('sticker queue')).toBeInTheDocument();
    expect(bookLink().elements()).toHaveLength(0);
  });
});
