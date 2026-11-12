import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type { PostEditMediaDetail } from '~/components/Post/EditV2/PostEditProvider';

/**
 * A failed or blocked upload's card shows the file's local preview url, which holds its bytes (an
 * in-memory copy of the pick, say). Removing the card releases that url with it.
 */

const mocks = vi.hoisted(() => ({ setImages: vi.fn(), showPreview: true }));

vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ setImages: mocks.setImages }),
  usePostPreviewContext: () => ({ showPreview: mocks.showPreview }),
}));

// eslint-disable-next-line import/first
import { ErrorImage } from '~/components/Post/EditV2/PostImageCards/ErrorImage';
// eslint-disable-next-line import/first
import { BlockedImage } from '~/components/Post/EditV2/PostImageCards/BlockedImage';
// eslint-disable-next-line import/first
import { PendingImage } from '~/components/Post/EditV2/PostImageCards/PendingImage';

const image = (url: string) =>
  ({ url, name: 'p.jpg', type: 'image', blockedFor: 'x' } as unknown as PostEditMediaDetail);

describe('a failed post image card', () => {
  beforeEach(() => {
    mocks.setImages.mockReset();
  });

  test.each([
    ['an error card, preview', ErrorImage, true],
    ['an error card, edit', ErrorImage, false],
    ['a blocked card, preview', BlockedImage, true],
    ['a blocked card, edit', BlockedImage, false],
  ] as const)('%s: removing it releases its blob: preview', async (_, Card, showPreview) => {
    mocks.showPreview = showPreview;
    const url = URL.createObjectURL(new Blob(['x'], { type: 'image/jpeg' }));
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      renderWithProviders(<Card image={image(url)} />);
      await userEvent.click(page.getByRole('button', { name: 'Remove' }));
      expect(mocks.setImages).toHaveBeenCalledTimes(1);
      const update = mocks.setImages.mock.calls[0][0] as (images: unknown[]) => unknown[];
      expect(update([{ data: { url } }, { data: { url: 'other' } }])).toEqual([
        { data: { url: 'other' } },
      ]);
      expect(revoke.mock.calls).toEqual([[url]]);
    } finally {
      revoke.mockRestore();
    }
  });

  test('a card with a non-blob url revokes nothing', async () => {
    mocks.showPreview = true;
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    try {
      renderWithProviders(<ErrorImage image={image('https://example.test/p.jpg')} />);
      await userEvent.click(page.getByRole('button', { name: 'Remove' }));
      expect(mocks.setImages).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      revoke.mockRestore();
    }
  });
});

describe('a failed or pending post card for a song', () => {
  const media = (type: 'image' | 'audio') =>
    ({
      url: 'https://example.test/a',
      name: 'a',
      type,
      blockedFor: 'x',
      metadata: { width: 100, height: 100 },
    } as unknown as PostEditMediaDetail);

  test.each([
    ['an error card, preview', ErrorImage, true],
    ['an error card, edit', ErrorImage, false],
    ['a blocked card, preview', BlockedImage, true],
    ['a blocked card, edit', BlockedImage, false],
    ['a pending card, preview', PendingImage, true],
    ['a pending card, edit', PendingImage, false],
  ] as const)('%s: renders no image for a song', async (_, Card, preview) => {
    mocks.showPreview = preview;
    renderWithProviders(<Card image={media('audio')} />);
    await expect.element(page.getByTestId('song-tile').first()).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test.each([true, false])('an error card (preview: %s) says the song failed', async (preview) => {
    mocks.showPreview = preview;
    renderWithProviders(<ErrorImage image={media('audio')} />);
    await expect.element(page.getByText('Failed to upload song')).toBeVisible();
  });

  test.each([
    ['an error card, preview', ErrorImage, true],
    ['an error card, edit', ErrorImage, false],
    ['a blocked card, preview', BlockedImage, true],
    ['a blocked card, edit', BlockedImage, false],
  ] as const)('%s: still shows an image upload', async (_, Card, preview) => {
    mocks.showPreview = preview;
    renderWithProviders(<Card image={media('image')} />);
    await expect.element(page.getByRole('button', { name: 'Remove' })).toBeVisible();
    expect(document.querySelector('img')).not.toBeNull();
  });
});
