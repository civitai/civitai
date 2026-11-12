import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as RemixUtils from '~/components/Image/Remix/remix.utils';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const h = vi.hoisted(() => ({
  seedApps: (): Record<string, unknown>[] => [],
  startRemix: vi.fn(() => Promise.resolve()),
  openModal: vi.fn(),
  openPicker: vi.fn(),
  /** The viewer's saved settings; `remixApps.pinned` is what the menu reads. */
  settings: undefined as undefined | { remixApps?: { pinned: string[] } },
  saveSettings: vi.fn(),
  /** The viewer's remix workflows, newest first: where recents come from. */
  workflows: [] as { tags: string[] }[],
  flags: { remixApps: true, isGreen: false } as Record<string, boolean>,
  user: { id: 9, showNsfw: true } as { id: number; showNsfw: boolean } | null,
  quoteEnabled: [] as boolean[],
  /** What `remixApp.list` serves; null = the seed apps, all listed. */
  apps: null as null | Record<string, unknown>[],
  /** What the open menu's quote returns; the default prices both kinds of app at 25. */
  quote: null as null | {
    isLoading: boolean;
    isError?: boolean;
    prices?: Record<string, unknown>[];
  },
}));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: () => Promise.resolve() }),
}));
vi.mock('~/components/Image/Remix/remix.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixUtils>()),
  startRemix: h.startRemix,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: false, setBlockedTarget: vi.fn() }),
}));
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useOptionalFeatureFlags: () => h.flags,
}));
vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOptionalCivitaiSessionContext: () =>
    h.user ? { type: 'authed', ...h.user } : { type: 'unauthed' },
}));
vi.mock('~/components/Dialog/triggers/remix-app', () => ({
  openRemixAppModal: h.openModal,
  openRemixAppPicker: h.openPicker,
}));
vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUserSettingsState: () => ({ settings: h.settings, isResolved: true }),
  useMutateUserSettings: () => ({ mutate: h.saveSettings }),
}));
vi.mock('~/components/Image/Remix/useRemixRuns', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRemixWorkflows: () => ({ data: h.workflows }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  const original = await importOriginal<{ trpc: { orchestrator: unknown } }>();
  return {
    ...original,
    trpc: makeTrpcProxy(
      {
        'remixApp.list': {
          useQuery: () => ({ data: h.apps ?? h.seedApps() }),
        },
        'remixApp.quote': {
          useQuery: (input: { imageId: number }, opts: { enabled: boolean }) => {
            h.quoteEnabled.push(opts.enabled);
            const quote = h.quote ?? {
              isLoading: false,
              prices: [
                { slug: 'make-it-real', cost: 25, ready: true },
                { slug: 'anime-it', cost: 25, ready: true },
              ],
            };
            return {
              data: opts.enabled && quote.prices ? { prices: quote.prices } : undefined,
              isLoading: quote.isLoading,
              isError: !!quote.isError,
            };
          },
        },
      },
      // The real router, so the queue's query key is the one the generator caches under.
      { orchestrator: original.trpc.orchestrator }
    ),
  };
});

import { Menu } from '@mantine/core';
import { RemixAppsSection } from '~/components/Image/Remix/RemixApps';
import { RemixMenu } from '~/components/Image/Remix/RemixMenu';
import type { RemixSourceImage } from '~/components/Image/Remix/remix.utils';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import { SEED_REMIX_APPS } from '~/shared/remix-apps/seed';
import { REMIX_MENU_ROWS } from '~/shared/remix-apps/menu';

/** The seed as `remixApp.list` returns it before any row exists. */
const REMIX_MENU_APPS = SEED_REMIX_APPS.map(({ slug, name, description, target, spec }) => ({
  slug,
  name,
  description,
  target,
  icon: spec.icon,
  enabled: true,
  engine: 'engine' in spec ? spec.engine : DEFAULT_ENGINE,
  output: 'image' as const,
}));
h.seedApps = () => REMIX_MENU_APPS;

const video: RemixSourceImage = {
  id: 1,
  url: 'abc-123',
  type: 'video' as RemixSourceImage['type'],
  nsfwLevel: 1,
  ingestion: 'Scanned',
  hasPositivePrompt: false,
};
const firstApp = REMIX_MENU_APPS.find((app) => app.slug === 'make-it-real')!;
const runtimeApp = REMIX_MENU_APPS.find((app) => app.slug === 'anime-it')!;

const renderMenu = (image: RemixSourceImage) =>
  renderWithProviders(
    <RemixMenu image={image} source="test">
      <button type="button">Remix</button>
    </RemixMenu>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.flags = { remixApps: true, isGreen: false };
  h.user = { id: 9, showNsfw: true };
  h.quoteEnabled = [];
  h.quote = null;
  h.apps = null;
  h.settings = undefined;
  h.workflows = [];
});

describe('Remix apps in the Remix menu', () => {
  test('a source with one built-in option still opens the menu when apps exist', async () => {
    renderMenu(video);
    // Priced only once open: a card that was merely rendered asks for no quote.
    expect(h.quoteEnabled.filter(Boolean)).toEqual([]);
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).not.toHaveBeenCalled();
    await expect.element(page.getByText('Remix apps')).toBeVisible();
    expect(h.quoteEnabled.at(-1)).toBe(true);
    for (const app of REMIX_MENU_APPS.slice(0, REMIX_MENU_ROWS))
      await expect.element(page.getByRole('menuitem', { name: app.name })).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: 'See more' })).toBeVisible();
  });

  test('lists neither a disabled app nor one for videos', async () => {
    h.apps = [
      { ...firstApp, enabled: false },
      { ...runtimeApp, target: 'video.remix' },
      { ...REMIX_MENU_APPS[2] },
    ];
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();

    // POSITIVE CONTROL: the enabled image app beside them is listed.
    await expect
      .element(page.getByRole('menuitem', { name: REMIX_MENU_APPS[2].name }))
      .toBeVisible();
    await expect
      .element(page.getByRole('menuitem', { name: firstApp.name }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole('menuitem', { name: runtimeApp.name }))
      .not.toBeInTheDocument();
  });

  test('with the flag off the sole option runs without a menu', async () => {
    h.flags = { remixApps: false };
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).toHaveBeenCalledTimes(1);
  });

  test('a mature source offers no apps to a viewer with mature content off', async () => {
    h.user = { id: 9, showNsfw: false };
    renderMenu({ ...video, nsfwLevel: 8 });
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).toHaveBeenCalledTimes(1);
  });

  test('a mature source on green offers no apps', async () => {
    h.flags = { remixApps: true, isGreen: true };
    renderMenu({ ...video, nsfwLevel: 8 });
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).toHaveBeenCalledTimes(1);
  });

  test('an app opens its modal for this image, and runs nothing from the menu', async () => {
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();
    await page.getByRole('menuitem', { name: runtimeApp.name }).click();

    expect(h.openModal).toHaveBeenCalledTimes(1);
    expect(h.openModal.mock.calls[0][0]).toEqual({
      app: { slug: runtimeApp.slug, name: runtimeApp.name, runtime: true },
      imageId: video.id,
    });
  });

  test('a signed-out viewer is offered no apps', async () => {
    h.user = null;
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).toHaveBeenCalledTimes(1);
  });

  describe('nothing runs without a price on screen', () => {
    const section = () => (
      <Menu opened>
        <Menu.Target>
          <button type="button">target</button>
        </Menu.Target>
        <Menu.Dropdown>
          <RemixAppsSection apps={[firstApp]} imageId={video.id} openCount={1} />
        </Menu.Dropdown>
      </Menu>
    );
    const item = () => page.getByRole('menuitem', { name: firstApp.name });
    /** A DOM click, which a disabled item ignores, where a pointer click would wait for it. */
    const tap = () => (item().element() as HTMLElement).click();

    test('while the quote loads, the app cannot be opened', async () => {
      h.quote = { isLoading: true };
      const screen = await renderWithProviders(section());
      await expect.element(item()).toBeDisabled();
      tap();
      expect(h.openModal).not.toHaveBeenCalled();

      // POSITIVE CONTROL: once priced, the same tap opens the app.
      h.quote = null;
      await screen.rerender(section());
      await expect.element(item()).toBeEnabled();
      tap();
      expect(h.openModal).toHaveBeenCalledTimes(1);
    });

    test('a failed quote says the price is unavailable and how to retry', async () => {
      h.quote = { isLoading: false, isError: true };
      await renderWithProviders(section());
      await expect.element(page.getByText(/Price unavailable/)).toBeVisible();
      await expect.element(item()).toBeDisabled();
    });

    test('a refused price is shown in place of the price, and the app cannot be opened', async () => {
      h.quote = {
        isLoading: false,
        prices: [{ slug: firstApp.slug, refusal: 'This engine is busy right now.' }],
      };
      const screen = await renderWithProviders(section());
      await expect.element(page.getByText('This engine is busy right now.')).toBeVisible();
      await expect.element(item()).toBeDisabled();
      tap();
      expect(h.openModal).not.toHaveBeenCalled();

      // POSITIVE CONTROL: the same item with a price opens the app.
      h.quote = null;
      await screen.rerender(section());
      await expect.element(item()).toBeEnabled();
      tap();
      expect(h.openModal).toHaveBeenCalledTimes(1);
    });
  });
  describe('pinned, then recent, then the rest', () => {
    const many = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((name) => ({
      ...firstApp,
      slug: `app-${name}`,
      name: `App ${name}`,
    }));
    const names = async () =>
      (await page.getByRole('menuitem').all())
        .map((item) => item.element().textContent ?? '')
        .filter((text) => text.startsWith('App '))
        .map((text) => text.replace(/\d+\s*BUZZ$/, '').trim());

    beforeEach(() => {
      h.apps = many;
      h.quote = {
        isLoading: false,
        prices: many.map((app) => ({ slug: app.slug, cost: 25, ready: true })),
      };
    });

    test('shows pins first, tops up with recents, and offers the rest under See more', async () => {
      h.settings = { remixApps: { pinned: ['app-six', 'gone-app'] } };
      h.workflows = [{ tags: ['remix-app', 'remix-app:app-four'] }];
      renderMenu(video);
      await page.getByRole('button', { name: 'Remix' }).click();
      await expect.element(page.getByRole('menuitem', { name: 'See more' })).toBeVisible();

      expect(await names()).toEqual(['App six', 'App four', 'App one', 'App two', 'App three']);

      await page.getByRole('menuitem', { name: 'See more' }).click();
      expect(h.openPicker).toHaveBeenCalledTimes(1);
      // The picker gets every app this viewer can run here, not just the five shown.
      expect(h.openPicker.mock.calls[0][0]).toMatchObject({ apps: many, imageId: video.id });
    });

    test('See more is offered even when every app fits, since pinning lives there', async () => {
      h.apps = many.slice(0, 2);
      renderMenu(video);
      await page.getByRole('button', { name: 'Remix' }).click();
      await expect.element(page.getByRole('menuitem', { name: 'See more' })).toBeVisible();
    });

    test('an unpinned row has no pin target, so a tap there opens the app', async () => {
      h.apps = many.slice(0, 2);
      h.settings = { remixApps: { pinned: ['app-two'] } };
      renderMenu(video);
      await page.getByRole('button', { name: 'Remix' }).click();
      await expect
        .element(page.getByRole('menuitem', { name: 'App two' }).getByTitle('Unpin'))
        .toBeVisible();
      await expect
        .element(page.getByRole('menuitem', { name: 'App one' }).getByTitle(/pin/i))
        .not.toBeInTheDocument();

      await page.getByRole('menuitem', { name: 'App one' }).click();
      expect(h.openModal).toHaveBeenCalledTimes(1);
      expect(h.openModal.mock.calls[0][0]).toMatchObject({ app: { slug: 'app-one' } });
    });

    test('the pin icon unpins an app without opening it, and saves the rest', async () => {
      h.settings = { remixApps: { pinned: ['app-six', 'app-two'] } };
      renderMenu(video);
      await page.getByRole('button', { name: 'Remix' }).click();
      await page.getByRole('menuitem', { name: 'App six' }).getByTitle('Unpin').click();

      expect(h.openModal).not.toHaveBeenCalled();
      await expect.poll(() => h.saveSettings.mock.calls.length, { timeout: 3000 }).toBe(1);
      expect(h.saveSettings).toHaveBeenCalledWith({ remixApps: { pinned: ['app-two'] } });
    });
  });
});
