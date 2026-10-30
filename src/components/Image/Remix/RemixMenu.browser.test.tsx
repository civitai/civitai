import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as RemixUtils from '~/components/Image/Remix/remix.utils';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const { startRemix, startPromptReuse, tour } = vi.hoisted(() => ({
  startRemix: vi.fn(() => Promise.resolve()),
  startPromptReuse: vi.fn(() => Promise.resolve()),
  tour: { running: false },
}));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction: () => Promise.resolve() }),
}));
vi.mock('~/components/Image/Remix/remix.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof RemixUtils>()),
  startRemix,
  startPromptReuse,
}));
vi.mock('~/components/Tours/ToursProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof ToursProvider>()),
  useTourContext: () => ({ running: tour.running, setBlockedTarget: vi.fn() }),
}));

import { RemixMenu } from '~/components/Image/Remix/RemixMenu';
import type { RemixSourceImage } from '~/components/Image/Remix/remix.utils';

const base: RemixSourceImage = {
  id: 1,
  url: 'abc-123',
  type: 'image' as RemixSourceImage['type'],
  nsfwLevel: 1,
  ingestion: 'Scanned',
  hasPositivePrompt: true,
};
const imageWithPrompt = base;
const videoWithPrompt = { ...base, type: 'video' as RemixSourceImage['type'] };
const flaggedImage = { ...base, minor: true };

const renderMenu = (
  image: RemixSourceImage,
  props: Partial<React.ComponentProps<typeof RemixMenu>> = {}
) => {
  const onAction = vi.fn();
  renderWithProviders(
    <RemixMenu image={image} source="test" onAction={onAction} {...props}>
      <button type="button">Remix</button>
    </RemixMenu>
  );
  return { onAction };
};

beforeEach(() => {
  vi.clearAllMocks();
  tour.running = false;
});

describe('RemixMenu count rule', () => {
  test('one option: a click runs it and opens no menu', async () => {
    const { onAction } = renderMenu(videoWithPrompt);

    await page.getByRole('button', { name: 'Remix' }).click();

    expect(startPromptReuse).toHaveBeenCalledTimes(1);
    expect(startRemix).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(page.getByText('Reuse prompt & resources').query()).toBeNull();
  });

  // Positive control: the same harness does see a menu when there is more than one option.
  test('several options: a click opens the menu and runs nothing', async () => {
    const { onAction } = renderMenu(imageWithPrompt);

    await page.getByRole('button', { name: 'Remix' }).click();

    await expect.element(page.getByText('Edit image')).toBeVisible();
    await expect.element(page.getByText('Animate')).toBeVisible();
    await expect.element(page.getByText('Reuse prompt & resources')).toBeVisible();
    expect(startPromptReuse).not.toHaveBeenCalled();
    expect(startRemix).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  test('a refusal that leaves one option still opens the menu, with the reason', async () => {
    renderMenu(flaggedImage);

    await page.getByRole('button', { name: 'Remix' }).click();

    await expect.element(page.getByText(/may depict a minor/)).toBeVisible();
    expect(startPromptReuse).not.toHaveBeenCalled();
  });

  test('while a tour runs on this menu, one option still opens the menu', async () => {
    tour.running = true;
    renderMenu(videoWithPrompt, { tourTarget: 'gen:remix-menu' });

    await page.getByRole('button', { name: 'Remix' }).click();

    await expect.element(page.getByText('Reuse prompt & resources')).toBeVisible();
    expect(startPromptReuse).not.toHaveBeenCalled();
  });
});
