import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { SongMeta } from '~/components/Image/DetailV2/ImageMeta';

/** A generated song's meta, as `image.getGenerationData` serves it. */
const meta = {
  workflow: 'txt2music',
  ecosystem: 'MiniMaxMusic3',
  seed: 1945495925,
  duration: 30,
  minimaxMusicMode: 'custom',
  musicDescription: 'synthwave, female vocals, driving bass',
  lyrics: '[Verse 1] City lights are fading on the water',
};

describe("a song's generation data", () => {
  test('shows its style prompt, model and seed', async () => {
    renderWithProviders(
      <SongMeta meta={meta} model={{ modelName: 'MiniMax Music', versionName: 'v3.0' }} />
    );

    await expect.element(page.getByText('Style', { exact: true })).toBeVisible();
    await expect.element(page.getByText('synthwave, female vocals, driving bass')).toBeVisible();
    await expect.element(page.getByText('MiniMax Music v3.0')).toBeVisible();
    await expect.element(page.getByText('1945495925')).toBeVisible();
  });

  test("names an on-site song's generator Civitai, and one made elsewhere External", async () => {
    const screen = renderWithProviders(<SongMeta meta={meta} onSite />);
    await expect.element(page.getByText('Civitai Generator')).toBeVisible();
    (await screen).rerender(<SongMeta meta={meta} onSite={false} />);
    await expect.element(page.getByText('External Generator')).toBeVisible();
  });

  test('names the model by its ecosystem when the song has no resource', async () => {
    renderWithProviders(<SongMeta meta={meta} />);
    await expect.element(page.getByText('MiniMax Music 3')).toBeVisible();
  });

  test('lists no lyrics or raw generator keys', async () => {
    renderWithProviders(<SongMeta meta={meta} />);
    await expect.element(page.getByText('Style', { exact: true })).toBeVisible();

    for (const text of ['Other metadata', 'txt2music', 'MiniMaxMusic3', 'Verse 1', 'custom'])
      await expect.element(page.getByText(text, { exact: false })).not.toBeInTheDocument();
  });
});
