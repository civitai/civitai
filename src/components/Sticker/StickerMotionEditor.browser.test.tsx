import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
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

    vi.mocked(video.pause).mockClear();
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

  test('Escape in a dialog closes the dialog, not Movement', async () => {
    await page.getByText('Movement').click();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inside = document.createElement('button');
    dialog.append(inside);
    document.body.append(dialog);
    inside.focus();

    await userEvent.keyboard('{Escape}');
    expect(selected().motion?.on).toBe(true);
    dialog.remove();
  });

  test('a long run of fades says why it cannot be placed, and hides the floating Place', async () => {
    store.getState().setPrimaryLabel(selected().id, 'Place free');
    await page.getByText('Movement').click();
    await expect.element(page.getByRole('button', { name: 'Place free' })).toBeInTheDocument();

    // Nine fades of a second each: every one is short, together they pass the limit.
    const keys = Array.from({ length: 10 }, (_, i) => ({
      t: i * 1000,
      x: 0.2,
      y: 0.5,
      s: 0.2,
      r: 0,
      o: i % 2 ? 1 : 0,
      ease: 'smooth' as const,
    }));
    store.getState().setKeys(selected().id, keys);
    await expect.element(page.getByRole('alert')).toHaveTextContent(/too much fading/i);
    await expect.element(page.getByRole('button', { name: 'Place free' })).not.toBeInTheDocument();
  });

  test('lowering the sticker’s opacity under a faint key says why it cannot be placed', async () => {
    await page.getByText('Movement').click();
    const [first] = selected().motion!.keys;
    store.getState().setKeys(selected().id, [{ ...first, o: 0.3 }]);
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();

    // Opacity sets no key, so the 30% key now draws at 15%, which the server refuses.
    store.getState().move(selected().id, { opacity: 0.5 });
    await expect.element(page.getByRole('alert')).toHaveTextContent(/too faint/i);
  });

  test('the floating Place is gone while previewing', async () => {
    store.getState().setPrimaryLabel(selected().id, 'Place free');
    await expect.element(page.getByRole('button', { name: 'Place free' })).toBeInTheDocument();
    store.getState().setPreviewing(true);
    await expect.element(page.getByRole('button', { name: 'Place free' })).not.toBeInTheDocument();
  });

  test('the floating Place presses only the selected draft’s button, and not while it is disabled', async () => {
    const id = selected().id;
    store.getState().setPrimaryLabel(id, 'Place free');
    const own = Object.assign(document.createElement('button'), { disabled: true });
    own.dataset.draftPrimary = id;
    const other = document.createElement('button');
    other.dataset.draftPrimary = 'another-draft';
    const ownPress = vi.fn();
    const otherPress = vi.fn();
    own.addEventListener('click', ownPress);
    other.addEventListener('click', otherPress);
    document.body.prepend(other, own);

    await page.getByRole('button', { name: 'Place free' }).click();
    expect(ownPress).not.toHaveBeenCalled();
    own.disabled = false;
    await page.getByRole('button', { name: 'Place free' }).click();
    expect(ownPress).toHaveBeenCalledTimes(1);
    expect(otherPress).not.toHaveBeenCalled();
    own.remove();
    other.remove();
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

  test('tells the store when the video plays and pauses, and stops claiming it plays once closed', async () => {
    await page.getByText('Movement').click();
    await video.play();
    await expect.poll(() => store.getState().videoPlaying).toBe(true);
    video.pause();
    await expect.poll(() => store.getState().videoPlaying).toBe(false);

    await video.play();
    await expect.poll(() => store.getState().videoPlaying).toBe(true);
    // Opening the tray closes the timeline while the video is still playing.
    store.setState({ trayOpen: true });
    await expect.poll(() => store.getState().videoPlaying).toBe(false);
  });
});

describe('the timeline inside the image detail dialog', () => {
  test('its keys step the video, not the carousel the dialog holds', async () => {
    // The detail view opened from a feed is a modal: the video and the editor sit inside it.
    const host = page
      .getByRole('radiogroup', { name: 'Sticker mode' })
      .element()
      .closest<HTMLElement>('[style*="600px"]')!;
    host.setAttribute('role', 'dialog');
    host.append(video);
    const carousel = vi.fn();
    const onCarouselKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'ArrowRight') carousel();
    };
    document.addEventListener('keydown', onCarouselKey, true);
    onTestFinished(() => document.removeEventListener('keydown', onCarouselKey, true));

    await page.getByText('Movement').click();
    await userEvent.keyboard('{ArrowRight}');

    expect(video.currentTime).toBeCloseTo(0.1);
    expect(carousel).not.toHaveBeenCalled();
  });
});

describe('the mode choice while the tray is open', () => {
  let tray: HTMLDivElement | undefined;
  afterEach(() => tray?.remove());

  const openTray = () => {
    tray = document.createElement('div');
    Object.assign(tray.style, {
      position: 'fixed',
      left: '0',
      right: '0',
      bottom: '0',
      height: '160px',
    });
    document.body.appendChild(tray);
    store.setState({ trayOpen: true, tray });
    return tray;
  };

  test('sits on top of the tray rather than under it', async () => {
    const trayTop = openTray().getBoundingClientRect().top;
    const control = () =>
      page.getByRole('radiogroup', { name: 'Sticker mode' }).element().getBoundingClientRect();

    await expect.poll(() => Math.round(control().bottom)).toBe(Math.round(trayTop));
    expect(control().height).toBeGreaterThan(0);
  });

  test('Movement puts the tray away and opens the timeline at the video frame', async () => {
    openTray();
    video.currentTime = 1.5;

    await page.getByText('Movement').click();

    expect(store.getState().trayOpen).toBe(false);
    expect(video.pause).toHaveBeenCalled();
    await expect.element(page.getByRole('group', { name: 'Sticker timeline' })).toBeVisible();
    expect(selected().motion?.keys.map((key) => key.t)).toEqual([1500]);
  });
});
