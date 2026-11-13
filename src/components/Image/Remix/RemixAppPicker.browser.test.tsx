import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const h = vi.hoisted(() => ({
  onClose: vi.fn(),
  openModal: vi.fn(),
  saveSettings: vi.fn(),
  settings: undefined as undefined | { remixApps?: { pinned: string[] } },
  quote: { isLoading: false } as { isLoading: boolean; prices?: Record<string, unknown>[] },
}));

vi.mock('~/components/Dialog/DialogProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDialogContext: () => ({ opened: true, onClose: h.onClose }),
}));
vi.mock('~/components/Dialog/triggers/remix-app', () => ({
  openRemixAppModal: h.openModal,
  openRemixAppPicker: vi.fn(),
}));
vi.mock('~/components/UserSettings/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useCurrentUserSettingsState: () => ({ settings: h.settings, isResolved: true }),
  useMutateUserSettings: () => ({ mutate: h.saveSettings }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<object>()),
    trpc: makeTrpcProxy({
      'remixApp.quote': {
        useQuery: () => ({
          data: h.quote.prices ? { prices: h.quote.prices } : undefined,
          isLoading: h.quote.isLoading,
          isError: false,
        }),
      },
    }),
  };
});

const { RemixAppPicker } = await import('~/components/Image/Remix/RemixAppPicker');

const app = (slug: string, name: string) => ({
  slug,
  name,
  icon: 'sparkles',
  description: `${name} does a thing`,
  target: 'image.remix' as const,
  enabled: true,
  engine: undefined as never,
  output: 'image' as const,
});
const apps = [app('restyle', 'Restyle'), app('anime-it', 'Anime it')];
const priced = { isLoading: false, prices: apps.map((a) => ({ slug: a.slug, cost: 25 })) };

beforeEach(() => {
  vi.clearAllMocks();
  h.settings = { remixApps: { pinned: ['anime-it'] } };
  h.quote = priced;
});

describe('RemixAppPicker', () => {
  test('lists every app, and marks the pinned ones', async () => {
    await renderWithProviders(<RemixAppPicker apps={apps} imageId={5} />);
    await expect.element(page.getByText('Restyle does a thing')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Unpin Anime it' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Pin Restyle' })).toBeVisible();
  });

  test('pins an app after the ones already pinned', async () => {
    await renderWithProviders(<RemixAppPicker apps={apps} imageId={5} />);
    await page.getByRole('button', { name: 'Pin Restyle' }).click();

    await expect.element(page.getByRole('button', { name: 'Unpin Restyle' })).toBeVisible();
    expect(h.openModal).not.toHaveBeenCalled();
    await expect.poll(() => h.saveSettings.mock.calls.length, { timeout: 3000 }).toBe(1);
    expect(h.saveSettings).toHaveBeenCalledWith({
      remixApps: { pinned: ['anime-it', 'restyle'] },
    });
  });

  test('tapping a priced app closes the picker and opens that app on this image', async () => {
    await renderWithProviders(<RemixAppPicker apps={apps} imageId={5} />);
    await page.getByRole('button', { name: /Restyle does a thing/ }).click();

    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.openModal).toHaveBeenCalledWith({
      app: { slug: 'restyle', name: 'Restyle', runtime: true },
      imageId: 5,
    });
  });

  test('nothing opens before a price is on screen', async () => {
    h.quote = { isLoading: true };
    const screen = await renderWithProviders(<RemixAppPicker apps={apps} imageId={5} />);
    const row = page.getByRole('button', { name: /Restyle does a thing/ });
    await expect.element(row).toBeDisabled();
    (row.element() as HTMLElement).click();
    expect(h.openModal).not.toHaveBeenCalled();

    // POSITIVE CONTROL: once priced, the same tap opens it.
    h.quote = priced;
    await screen.rerender(<RemixAppPicker apps={apps} imageId={5} />);
    await expect.element(row).toBeEnabled();
    (row.element() as HTMLElement).click();
    expect(h.openModal).toHaveBeenCalledTimes(1);
  });
});
