import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import {
  STORYLINE_CAPTION_HIDDEN_KEY,
  StorylineCaptionNote,
} from '~/components/Storyline/StorylineCaptionNote';

/** The reader's own caption bar: hideable over a chapter image, and the choice is theirs to keep. */

const CAPTION = 'The patch lands at dawn.';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(STORYLINE_CAPTION_HIDDEN_KEY);
});

describe('StorylineCaptionNote hide control', () => {
  test('hides the caption, then shows it again', async () => {
    renderWithProviders(<StorylineCaptionNote caption={CAPTION} hideable />);
    await expect.element(page.getByText(CAPTION)).toBeVisible();

    await page.getByRole('button', { name: 'Hide image description' }).click();
    await expect.element(page.getByText(CAPTION)).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Show image description' }).click();
    await expect.element(page.getByText(CAPTION)).toBeVisible();
  });

  test('the choice survives a remount, as it does when the reader swipes to the next image', async () => {
    const first = await renderWithProviders(<StorylineCaptionNote caption={CAPTION} hideable />);
    await page.getByRole('button', { name: 'Hide image description' }).click();
    await first.unmount();

    const read = vi.spyOn(Storage.prototype, 'getItem');
    renderWithProviders(<StorylineCaptionNote caption="Another caption" hideable />);
    // Absence only counts once the stored value has been read.
    await expect
      .poll(() => read.mock.calls.some(([k]) => k === STORYLINE_CAPTION_HIDDEN_KEY))
      .toBe(true);
    await expect
      .element(page.getByRole('button', { name: 'Show image description' }))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Another caption');
  });

  test('works from the keyboard', async () => {
    renderWithProviders(<StorylineCaptionNote caption={CAPTION} hideable />);
    const hide = page.getByRole('button', { name: 'Hide image description' });
    await expect.element(hide).toBeInTheDocument();
    (hide.element() as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    const show = page.getByRole('button', { name: 'Show image description' });
    await expect.element(show).toBeInTheDocument();
    (show.element() as HTMLElement).focus();
    await userEvent.keyboard(' ');
    await expect.element(page.getByText(CAPTION)).toBeVisible();
  });

  test('blocked storage still shows the caption and still hides it for the visit', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderWithProviders(<StorylineCaptionNote caption={CAPTION} hideable />);
    await expect.element(page.getByText(CAPTION)).toBeVisible();
    await page.getByRole('button', { name: 'Hide image description' }).click();
    await expect.element(page.getByText(CAPTION)).not.toBeInTheDocument();
  });

  test('a caption that is not hideable, such as the editor preview, has no control and ignores the choice', async () => {
    localStorage.setItem(STORYLINE_CAPTION_HIDDEN_KEY, '1');
    renderWithProviders(<StorylineCaptionNote caption={CAPTION} />);
    await expect.element(page.getByText(CAPTION)).toBeVisible();
    expect(page.getByRole('button', { name: /image description/ }).elements()).toHaveLength(0);
  });
});
