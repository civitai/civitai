import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as RemixUtils from '~/components/Image/Remix/remix.utils';
import type * as ToursProvider from '~/components/Tours/ToursProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const { startRemix, startPromptReuse, trackAction, tour } = vi.hoisted(() => ({
  trackAction: vi.fn(() => Promise.resolve()),
  startRemix: vi.fn(() => Promise.resolve()),
  startPromptReuse: vi.fn(() => Promise.resolve()),
  tour: { running: false },
}));

vi.mock('~/components/TrackView/track.utils', () => ({
  useTrackEvent: () => ({ trackAction }),
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
const videoNoPrompt = { ...videoWithPrompt, hasPositivePrompt: false };
const flaggedImage = { ...base, minor: true };

const renderMenu = (
  image: RemixSourceImage,
  props: Partial<React.ComponentProps<typeof RemixMenu>> = {}
) => {
  const onAction = vi.fn();
  const onOpen = vi.fn();
  const onButtonClick = vi.fn();
  renderWithProviders(
    <RemixMenu image={image} source="test" onAction={onAction} onOpen={onOpen} {...props}>
      <button type="button" onClick={onButtonClick}>
        Remix
      </button>
    </RemixMenu>
  );
  return { onAction, onOpen, onButtonClick };
};

beforeEach(() => {
  vi.clearAllMocks();
  tour.running = false;
});

describe('RemixMenu count rule', () => {
  test('one option: a click runs it, tracks it and opens no menu', async () => {
    const { onAction, onOpen, onButtonClick } = renderMenu(videoNoPrompt);

    await page.getByRole('button', { name: 'Remix' }).click();

    expect(startRemix).toHaveBeenCalledTimes(1);
    expect(startRemix).toHaveBeenCalledWith({ kind: 'video', image: videoNoPrompt });
    expect(startPromptReuse).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onButtonClick).toHaveBeenCalledTimes(1);
    expect(trackAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'Image_Remix_Click',
        details: expect.objectContaining({ source: 'test', remixKind: 'video' }),
      })
    );
    // The menu never opens, so a tour is not advanced a second time by `onOpen`.
    expect(onOpen).not.toHaveBeenCalled();
    // Absence has to be read after the time a wrongly opened menu would need to mount.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(page.getByRole('menu').query()).toBeNull();
    expect(
      page.getByRole('button', { name: 'Remix' }).element().getAttribute('aria-haspopup')
    ).toBe(null);
  });

  test('a tour that is not running does not stop the single option running', async () => {
    renderMenu(videoNoPrompt, { tourTarget: 'gen:remix-menu' });

    await page.getByRole('button', { name: 'Remix' }).click();

    expect(startRemix).toHaveBeenCalledTimes(1);
  });

  test('a tour running elsewhere (no tourTarget) does not stop it either', async () => {
    tour.running = true;
    renderMenu(videoNoPrompt);

    await page.getByRole('button', { name: 'Remix' }).click();

    expect(startRemix).toHaveBeenCalledTimes(1);
  });

  test('no options (blocked image): the menu opens with the reason and nothing runs', async () => {
    const { onOpen } = renderMenu({ ...base, ingestion: 'Blocked' });

    await page.getByRole('button', { name: 'Remix' }).click();

    await expect.element(page.getByText(/was blocked/)).toBeVisible();
    expect(startPromptReuse).not.toHaveBeenCalled();
    expect(startRemix).not.toHaveBeenCalled();
    // Opening is announced as before, once.
    expect(onOpen).toHaveBeenCalledTimes(1);
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

  test('a video with a prompt opens a menu offering the first frame and reuse', async () => {
    renderMenu(videoWithPrompt);

    await page.getByRole('button', { name: 'Remix' }).click();

    await expect.element(page.getByText('Animate first frame')).toBeVisible();
    await expect.element(page.getByText('Reuse prompt & resources')).toBeVisible();
    await page.getByText('Animate first frame').click();
    expect(startRemix).toHaveBeenCalledWith({ kind: 'video', image: videoWithPrompt });
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
