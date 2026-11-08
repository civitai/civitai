import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { StickerMotionEditor } from '~/components/Sticker/StickerMotionEditor';
import { useStickerPlacementDraftStore as store } from '~/store/sticker-placement-draft.store';
import { renderWithProviders } from '../../../test/component-setup';

// Diamonds are sized by Tailwind, which component tests do not load, so they are checked as present
// rather than visible.

/** A video with a 10 s timeline that plays and seeks without a file. */
function fakeVideo() {
  const video = document.createElement('video');
  let time = 0;
  let paused = true;
  Object.defineProperty(video, 'duration', { get: () => 10 });
  Object.defineProperty(video, 'paused', { get: () => paused });
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  video.play = vi.fn(async () => {
    paused = false;
    video.dispatchEvent(new Event('play'));
  });
  video.pause = vi.fn(() => {
    paused = true;
    video.dispatchEvent(new Event('pause'));
  });
  return video;
}

const selected = () => {
  const state = store.getState();
  return state.drafts.find((draft) => draft.id === state.selectedDraftId)!;
};

let video: HTMLVideoElement;

beforeEach(() => {
  store.getState().close();
  store.getState().open(74);
  store.getState().begin(9, { x: 0.2, y: 0.5 });
  store.getState().closeTray();
  video = fakeVideo();
  renderWithProviders(
    <div style={{ position: 'relative', width: 600, height: 400 }}>
      <StickerMotionEditor video={video} />
    </div>
  );
});

describe('the sticker timeline', () => {
  test('Movement opens the timeline with a key at the playhead; Static puts it away', async () => {
    await expect
      .element(page.getByRole('group', { name: 'Sticker timeline' }))
      .not.toBeInTheDocument();

    await page.getByText('Movement').click();

    await expect.element(page.getByRole('group', { name: 'Sticker timeline' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Key 1 at 0:00.0' })).toBeInTheDocument();
    expect(video.pause).toHaveBeenCalled();

    await page.getByText('Static').click();
    await expect
      .element(page.getByRole('group', { name: 'Sticker timeline' }))
      .not.toBeInTheDocument();
    expect(selected().motion).toMatchObject({ on: false });
  });

  test('stepping forward and moving the sticker sets a second key there', async () => {
    await page.getByText('Movement').click();
    await page.getByRole('button', { name: 'Forward one frame' }).click();
    await page.getByRole('button', { name: 'Forward one frame' }).click();
    expect(video.currentTime).toBeCloseTo(0.2);

    store.getState().move(selected().id, { x: 0.7 });

    await expect.element(page.getByRole('button', { name: 'Key 2 at 0:00.2' })).toBeInTheDocument();
    expect(selected().motion?.keys.map((key) => [key.t, key.x])).toEqual([
      [0, 0.2],
      [200, 0.7],
    ]);
  });

  test('the keyboard plays, steps a second with Shift, sets a key with K and leaves with Esc', async () => {
    await page.getByText('Movement').click();

    await userEvent.keyboard(' ');
    expect(video.play).toHaveBeenCalled();
    await userEvent.keyboard(' ');
    expect(video.pause).toHaveBeenCalled();

    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(video.currentTime).toBeCloseTo(1);
    await userEvent.keyboard('k');
    expect(selected().motion?.keys.map((key) => key.t)).toEqual([0, 1000]);

    await userEvent.keyboard('{Escape}');
    expect(selected().motion?.on).toBe(false);
  });

  test('a key’s ease and opacity change from the inspector', async () => {
    await page.getByText('Movement').click();
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    store.getState().move(selected().id, { x: 0.7 });
    await userEvent.keyboard(',');
    expect(video.currentTime).toBe(0);

    await page.getByRole('button', { name: 'Ease' }).click();
    await page.getByRole('menuitem', { name: 'Jump' }).click();
    expect(selected().motion?.keys[0].ease).toBe('jump');

    // Opacity 0 is how a key hides the sticker.
    (page.getByRole('slider', { name: 'Key opacity' }).element() as HTMLElement).focus();
    await userEvent.keyboard('{Home}');
    expect(selected().motion?.keys[0].o).toBe(0);
  });
});
