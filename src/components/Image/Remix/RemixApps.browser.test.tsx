import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as RemixUtils from '~/components/Image/Remix/remix.utils';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as Modals from '@mantine/modals';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const h = vi.hoisted(() => ({
  startRemix: vi.fn(() => Promise.resolve()),
  run: vi.fn(async (_input: { slug: string; imageId: number; nonce: string }) => ({
    workflowId: 'wf',
  })),
  confirm: vi.fn(),
  flags: { remixApps: true, isGreen: false } as Record<string, boolean>,
  user: { id: 9, showNsfw: true } as { id: number; showNsfw: boolean } | null,
  quoteEnabled: [] as boolean[],
  /** What the open menu's quote returns; the default prices the first app at 25. */
  quote: null as null | { isLoading: boolean; prices?: Record<string, unknown>[] },
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
vi.mock('@mantine/modals', async (importOriginal) => ({
  ...(await importOriginal<typeof Modals>()),
  openConfirmModal: h.confirm,
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<object>()),
    trpc: makeTrpcProxy({
      'remixApp.quote': {
        useQuery: (input: { imageId: number }, opts: { enabled: boolean }) => {
          h.quoteEnabled.push(opts.enabled);
          const quote = h.quote ?? {
            isLoading: false,
            prices: [{ slug: 'anime-it', cost: 25, ready: true }],
          };
          return {
            data: opts.enabled && quote.prices ? { prices: quote.prices } : undefined,
            isLoading: quote.isLoading,
            isError: false,
          };
        },
      },
    }),
    trpcVanilla: { remixApp: { run: { mutate: h.run } } },
  };
});

import { Menu } from '@mantine/core';
import { RemixAppsSection } from '~/components/Image/Remix/RemixApps';
import { RemixMenu } from '~/components/Image/Remix/RemixMenu';
import type { RemixSourceImage } from '~/components/Image/Remix/remix.utils';
import { SYSTEM_REMIX_APPS } from '~/shared/constants/remix-apps.constants';

const video: RemixSourceImage = {
  id: 1,
  url: 'abc-123',
  type: 'video' as RemixSourceImage['type'],
  nsfwLevel: 1,
  ingestion: 'Scanned',
  hasPositivePrompt: false,
};
const firstApp = SYSTEM_REMIX_APPS[0];

const renderMenu = (image: RemixSourceImage) =>
  renderWithProviders(
    <RemixMenu image={image} source="test">
      <button type="button">Remix</button>
    </RemixMenu>
  );

type ConfirmProps = { children: React.ReactElement; onConfirm: () => void };
const lastConfirm = () => h.confirm.mock.calls.at(-1)![0] as ConfirmProps;

beforeEach(() => {
  vi.clearAllMocks();
  h.flags = { remixApps: true, isGreen: false };
  h.user = { id: 9, showNsfw: true };
  h.quoteEnabled = [];
  h.quote = null;
  localStorage.clear();
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
    for (const app of SYSTEM_REMIX_APPS)
      await expect.element(page.getByRole('menuitem', { name: app.name })).toBeVisible();
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

  test('the first run confirms; "don\'t ask again" skips the confirm next time', async () => {
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();
    await page.getByRole('menuitem', { name: firstApp.name }).click();

    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.run).not.toHaveBeenCalled();

    renderWithProviders(lastConfirm().children);
    await expect.element(page.getByText('for 25 Buzz')).toBeInTheDocument();
    await page.getByRole('checkbox', { name: "Don't ask again" }).click();
    // A double click on Run repeats the same tap.
    lastConfirm().onConfirm();
    lastConfirm().onConfirm();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    expect(h.run.mock.calls[0][0]).toMatchObject({ slug: firstApp.slug, imageId: video.id });
    const firstNonce = h.run.mock.calls[0][0].nonce;
    expect(h.run.mock.calls[1][0].nonce).toBe(firstNonce);
    h.run.mockClear();

    await page.getByRole('button', { name: 'Remix' }).click();
    await page.getByRole('menuitem', { name: firstApp.name }).click();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    // A new menu open is a new tap.
    expect(h.run.mock.calls[0][0].nonce).not.toBe(firstNonce);
  });

  test('a signed-out viewer is offered no apps', async () => {
    h.user = null;
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).toHaveBeenCalledTimes(1);
  });

  test('two clicks in one open repeat the tap; the next open is a new tap', async () => {
    localStorage.setItem('remix-apps:confirmed', '1');
    // Mounted once and kept mounted, as Mantine does across a quick reopen.
    const section = (openCount: number) => (
      <Menu opened>
        <Menu.Target>
          <button type="button">target</button>
        </Menu.Target>
        <Menu.Dropdown>
          <RemixAppsSection apps={[firstApp]} imageId={video.id} openCount={openCount} />
        </Menu.Dropdown>
      </Menu>
    );
    const screen = await renderWithProviders(section(1));
    const item = page.getByRole('menuitem', { name: firstApp.name });
    await item.click();
    await item.click();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    const [first, second] = h.run.mock.calls.map((c) => c[0].nonce);
    expect(second).toBe(first);

    await screen.rerender(section(2));
    await item.click();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(3));
    expect(h.run.mock.calls[2][0].nonce).not.toBe(first);
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

    test('while the quote loads, the app cannot be run, confirmed before or not', async () => {
      h.quote = { isLoading: true };
      const screen = await renderWithProviders(section());
      await expect.element(item()).toBeDisabled();
      tap();
      localStorage.setItem('remix-apps:confirmed', '1');
      tap();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();

      // POSITIVE CONTROL: once priced, the same tap runs.
      h.quote = null;
      await screen.rerender(section());
      await expect.element(item()).toBeEnabled();
      tap();
      await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    });

    test('a refused price is shown in place of the price, and the app cannot be run', async () => {
      h.quote = {
        isLoading: false,
        prices: [{ slug: firstApp.slug, refusal: 'This engine is busy right now.' }],
      };
      const screen = await renderWithProviders(section());
      await expect.element(page.getByText('This engine is busy right now.')).toBeVisible();
      await expect.element(item()).toBeDisabled();
      tap();
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();

      // POSITIVE CONTROL: the same item with a price opens the confirm.
      h.quote = null;
      await screen.rerender(section());
      await expect.element(item()).toBeEnabled();
      tap();
      expect(h.confirm).toHaveBeenCalledTimes(1);
      renderWithProviders(lastConfirm().children);
      await expect.element(page.getByText('for 25 Buzz')).toBeInTheDocument();
    });
  });
});
