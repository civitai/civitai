import { describe, expect, test } from 'vitest';
import { useState } from 'react';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { recordImageLoadErrors } from '../../../test/image-load-errors';
import { SongArt } from '~/components/MusicPlayer/MusicPlayerParts';

// Nothing serves a cover in the test browser, so every cover fails to load here, as a replaced
// cover does once its file is deleted while a list read before the replacement still names it.
/* eslint-disable local-rules/no-unloadable-image-fixture -- these tests exercise the load-error path */
const OLD_COVER = 'a1b2c3d4-0000-4000-8000-000000000001';
const NEW_COVER = 'a1b2c3d4-0000-4000-8000-000000000002';
/* eslint-enable local-rules/no-unloadable-image-fixture */

const failedSrcs = recordImageLoadErrors();

function Replaceable() {
  const [url, setUrl] = useState(OLD_COVER);
  return (
    <>
      <SongArt url={url} width={40} iconSize={20} />
      <button onClick={() => setUrl(NEW_COVER)}>Replace</button>
    </>
  );
}

describe('SongArt', () => {
  test('shows the placeholder instead of a broken image when the cover fails to load', async () => {
    renderWithProviders(<SongArt url={OLD_COVER} width={40} iconSize={20} />);

    await expect.element(page.getByTestId('music-cover-placeholder')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  test('tries a new cover after the previous one failed', async () => {
    renderWithProviders(<Replaceable />);
    await expect.element(page.getByTestId('music-cover-placeholder')).toBeVisible();

    await userEvent.click(page.getByRole('button', { name: 'Replace' }));

    // The new cover's <img> was rendered: it is the one that loaded (and here, failed) next.
    await expect.poll(() => failedSrcs.some((src) => src.includes(NEW_COVER))).toBe(true);
  });
});
