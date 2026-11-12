import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { PostEditImageDetail } from '~/server/services/post.service';

const mocks = vi.hoisted(() => ({ updateImage: vi.fn(), deleteImage: vi.fn() }));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.updateImage': {
        useMutation: () => ({ mutate: mocks.updateImage, isPending: false }),
      },
      'image.delete': {
        useMutation: () => ({ mutateAsync: mocks.deleteImage, isPending: false }),
      },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ updateImage: vi.fn(), setImages: vi.fn(), post: { id: 1 } }),
  usePendingSave: () => undefined,
}));

// eslint-disable-next-line import/first
import { MusicCard } from '~/components/Post/EditV2/PostImageCards/MusicCard';
// eslint-disable-next-line import/first
import { useDeletePostImage } from '~/components/Post/EditV2/PostImageCards/useDeletePostImage';

const song = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 7,
    type: 'audio',
    url: 'song-key',
    name: 'song.mp3',
    hideMeta: false,
    meta: { seed: 2481930117 },
    metadata: { duration: 192, title: 'Midnight Arcade' },
    resourceHelper: [{ modelName: 'ACE-Step 1.5' }],
    lyrics: null,
    ...overrides,
  } as unknown as PostEditImageDetail);

describe('the music card', () => {
  beforeEach(() => {
    mocks.updateImage.mockReset();
    mocks.deleteImage.mockReset();
  });

  test('shows the song title, its source and duration, and no image', async () => {
    renderWithProviders(<MusicCard image={song()} />);
    await expect
      .element(page.getByRole('textbox', { name: 'Song title' }))
      .toHaveValue('Midnight Arcade');
    await expect.element(page.getByText('Made on Civitai')).toBeVisible();
    await expect.element(page.getByText('ACE-Step 1.5 · 3:12 · seed 2481930117')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });

  test('an untitled song invites a title', async () => {
    renderWithProviders(<MusicCard image={song({ metadata: { duration: 192 } })} />);
    await expect
      .element(page.getByRole('textbox', { name: 'Song title' }))
      .toHaveAttribute('placeholder', 'Untitled song');
  });

  test('editing the title saves it to the song', async () => {
    renderWithProviders(<MusicCard image={song()} />);
    const title = page.getByRole('textbox', { name: 'Song title' });
    await userEvent.clear(title);
    await userEvent.type(title, 'Neon Rain');
    await userEvent.tab();
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, title: 'Neon Rain' });
  });

  test('shows the lyrics read-only, with times only on timed lines', async () => {
    renderWithProviders(
      <MusicCard
        image={song({
          lyrics: [
            { t: null, text: '[Verse 1]' },
            { t: 12000, text: 'Coins in the slot, the city hums in blue' },
          ],
        })}
      />
    );
    await expect.element(page.getByText('[Verse 1]')).toBeVisible();
    await expect.element(page.getByText('Coins in the slot, the city hums in blue')).toBeVisible();
    await expect.element(page.getByText('0:12')).toBeVisible();
    await expect
      .element(page.getByText("Locked · the generator's timestamps drive synced lyrics"))
      .toBeVisible();
    expect(page.getByRole('textbox').all()).toHaveLength(1);
  });

  test('a song without lyrics shows no lyrics block', async () => {
    renderWithProviders(<MusicCard image={song()} />);
    await expect.element(page.getByText('Made on Civitai')).toBeVisible();
    await expect.element(page.getByText('Lyrics', { exact: true })).not.toBeInTheDocument();
  });

  test('turning on Hide prompt saves hideMeta', async () => {
    renderWithProviders(<MusicCard image={song()} />);
    await userEvent.click(page.getByRole('switch', { name: 'Hide prompt' }));
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, hideMeta: true });
  });

  test('remixes are allowed by default, and turning them off saves allowRemix', async () => {
    renderWithProviders(<MusicCard image={song()} />);
    const allow = page.getByRole('switch', { name: 'Allow remixes' });
    await expect.element(allow).toBeChecked();
    await userEvent.click(allow);
    expect(mocks.updateImage).toHaveBeenLastCalledWith({ id: 7, allowRemix: false });
  });

  test('removing a song asks to delete the song', async () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    try {
      renderWithProviders(<MusicCard image={song()} />);
      await userEvent.click(page.getByRole('button', { name: 'Remove song' }));
      expect(trigger.mock.calls[0][0].props).toMatchObject({
        title: 'Delete song',
        message: 'Are you sure you want to delete this song?',
      });
    } finally {
      trigger.mockRestore();
    }
  });

  test('removing an image keeps the image copy', async () => {
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    function ImageRemove() {
      const { onDelete } = useDeletePostImage(8, 'image');
      return <button onClick={onDelete}>Remove</button>;
    }
    try {
      renderWithProviders(<ImageRemove />);
      await userEvent.click(page.getByRole('button', { name: 'Remove' }));
      expect(trigger.mock.calls[0][0].props).toMatchObject({
        title: 'Delete image',
        message: 'Are you sure you want to delete this image?',
      });
    } finally {
      trigger.mockRestore();
    }
  });
});
