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
        useQuery: () => ({ data: { cost: 25 }, isLoading: false, isError: false }),
      },
    }),
    trpcVanilla: { remixApp: { run: { mutate: h.run } } },
  };
});

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
  localStorage.clear();
});

describe('Remix apps in the Remix menu', () => {
  test('a source with one built-in option still opens the menu when apps exist', async () => {
    renderMenu(video);
    await page.getByRole('button', { name: 'Remix' }).click();

    expect(h.startRemix).not.toHaveBeenCalled();
    await expect.element(page.getByText('Remix apps')).toBeVisible();
    for (const app of SYSTEM_REMIX_APPS)
      await expect.element(page.getByRole('menuitem', { name: app.name })).toBeVisible();
  });

  test('with the flag off the sole option runs without a menu', async () => {
    h.flags = { remixApps: false };
    renderMenu(video);
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
    lastConfirm().onConfirm();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    expect(h.run.mock.calls[0][0]).toMatchObject({ slug: firstApp.slug, imageId: video.id });

    await page.getByRole('button', { name: 'Remix' }).click();
    await page.getByRole('menuitem', { name: firstApp.name }).click();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.run.mock.calls[1][0].nonce).not.toBe(h.run.mock.calls[0][0].nonce);
  });
});
