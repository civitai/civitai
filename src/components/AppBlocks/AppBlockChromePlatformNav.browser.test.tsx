import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';

// Part A: the app icon opens a Menu of the Civitai App PLATFORM's own pages
// (Apps home / Installed apps / My submissions / Review). "Review" is gated on
// the viewer's moderator flag. Part B: the ⋯ menu gains a "Permissions &
// activity" item (only when an appBlockId is threaded) that opens a per-app
// transparency drawer.
//
// AppBlockChrome calls useCurrentUser() (mod gate) — mock it with a mutable
// holder so we can drive both a non-mod and a mod viewer. The drawer body
// (mounted when opened) calls trpc hooks — mock the client so opening it is
// network-free (its data-driven behaviour is covered in
// AppPermissionsActivityDrawer.browser.test.tsx).
const holder = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => holder.user,
}));

vi.mock('~/utils/trpc', () => ({
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    blocks: {
      listMyScopeGrants: { useQuery: () => ({ data: [], isLoading: false }) },
      listMyAppActivity: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
      listMyScopeInvocations: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: [], nextCursor: null }] },
          isLoading: false,
          hasNextPage: false,
          isFetchingNextPage: false,
          fetchNextPage: vi.fn(),
        }),
      },
    },
    // W13 — AppActivityPanel (mounted by the drawer) resolves rich-detail ids via
    // these batch lookups. Stub them (empty fixtures → inert).
    modelVersion: { getVersionsByIds: { useQuery: () => ({ data: undefined }) } },
    useQueries: () => [],
  },
}));

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { renderWithProviders } from '../../../test/component-setup';

beforeEach(() => {
  holder.user = null;
});

async function openPlatformNav() {
  await page.getByRole('button', { name: 'Apps menu' }).click();
  // "Apps home" is present for every viewer — wait on it so the dropdown mounted.
  await expect.element(page.getByRole('menuitem', { name: 'Apps home' })).toBeInTheDocument();
}

describe('AppBlockChrome platform-nav menu (Part A)', () => {
  test('the app icon opens a Menu of the platform routes (home / installed / submissions)', async () => {
    holder.user = { id: 1, username: 'viewer', isModerator: false };
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-nav" appName="Budgeted Generator" slotId="app.page" />
    );
    await openPlatformNav();

    const home = page.getByRole('menuitem', { name: 'Apps home' }).element();
    expect(home.getAttribute('href')).toBe('/apps');

    const installed = page.getByRole('menuitem', { name: 'Installed apps' }).element();
    expect(installed.getAttribute('href')).toBe('/apps/installed');

    const submissions = page.getByRole('menuitem', { name: 'My submissions' }).element();
    expect(submissions.getAttribute('href')).toBe('/apps/my-submissions');
  });

  test('"Review" is HIDDEN for a non-moderator viewer', async () => {
    holder.user = { id: 1, username: 'viewer', isModerator: false };
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-nonmod" appName="App" slotId="app.page" />
    );
    await openPlatformNav();
    await expect
      .element(page.getByRole('menuitem', { name: 'Review' }))
      .not.toBeInTheDocument();
  });

  test('"Review" is SHOWN for a moderator and links to /apps/review', async () => {
    holder.user = { id: 2, username: 'mod', isModerator: true };
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-mod" appName="App" slotId="app.page" />
    );
    await openPlatformNav();
    const review = page.getByRole('menuitem', { name: 'Review' }).element();
    expect(review.getAttribute('href')).toBe('/apps/review');
  });

  test('the provenance icon (role=img, "App") is preserved inside the menu trigger', async () => {
    holder.user = null;
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-prov" appName="App" slotId="app.page" />
    );
    // The trust marker survives the icon becoming a menu trigger.
    await expect.element(page.getByRole('img', { name: 'App' })).toBeInTheDocument();
  });
});

describe('AppBlockChrome "Permissions & activity" item (Part B)', () => {
  async function openAppMenu() {
    await page.getByRole('button', { name: 'App menu' }).click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .toBeInTheDocument();
  }

  test('the ⋯ menu shows "Permissions & activity" and clicking it opens the drawer', async () => {
    holder.user = { id: 1, username: 'viewer', isModerator: false };
    renderWithProviders(
      <AppBlockChrome
        blockInstanceId="inst-perms"
        appBlockId="ab-1"
        appName="Budgeted Generator"
        slotId="app.page"
      />
    );
    await openAppMenu();
    await page.getByRole('menuitem', { name: 'Permissions & activity' }).click();
    await expect
      .element(page.getByTestId('app-permissions-activity-drawer'))
      .toBeInTheDocument();
  });

  test('the "Permissions & activity" item is ABSENT when no appBlockId is threaded', async () => {
    holder.user = { id: 1, username: 'viewer', isModerator: false };
    renderWithProviders(
      <AppBlockChrome blockInstanceId="inst-noab" appName="App" slotId="app.page" />
    );
    await openAppMenu();
    await expect
      .element(page.getByRole('menuitem', { name: 'Permissions & activity' }))
      .not.toBeInTheDocument();
  });
});
