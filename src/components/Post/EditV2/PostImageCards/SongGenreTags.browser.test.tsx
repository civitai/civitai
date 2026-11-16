import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../../test/component-setup';
import type * as PostEditProviderMod from '~/components/Post/EditV2/PostEditProvider';
import type * as TrpcModule from '~/utils/trpc';
import type { PostEditImageDetail } from '~/server/services/post.service';

const mocks = vi.hoisted(() => ({
  setGenre: vi.fn(),
  addTag: vi.fn(),
  removeTag: vi.fn(),
  updateImage: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.setSongGenre': { useMutation: () => ({ mutate: mocks.setGenre, isPending: false }) },
      'post.addSongTag': { useMutation: () => ({ mutate: mocks.addTag, isPending: false }) },
      'post.removeSongTag': { useMutation: () => ({ mutate: mocks.removeTag, isPending: false }) },
      'post.getTags': { useQuery: () => ({ data: [{ id: 3, name: 'night drive' }] }) },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ updateImage: mocks.updateImage }),
}));

// eslint-disable-next-line import/first
import { SongGenreTags } from '~/components/Post/EditV2/PostImageCards/SongGenreTags';

const song = (metadata: object, songTags: { id: number; name: string }[] = []) =>
  ({
    id: 7,
    type: 'audio',
    metadata: { duration: 120, ...metadata },
    songTags,
  } as unknown as PostEditImageDetail);

const genreSelect = () => page.getByRole('textbox', { name: 'Genre' });

beforeEach(() => vi.clearAllMocks());

describe('the song card genre select', () => {
  test('lists the genres and saves the one picked', async () => {
    renderWithProviders(<SongGenreTags image={song({ genre: 'Pop' })} />);

    await genreSelect().click();
    await expect.element(page.getByRole('option', { name: 'Synthwave' })).toBeInTheDocument();
    await page.getByRole('option', { name: 'Lo-fi' }).click();

    expect(mocks.setGenre).toHaveBeenCalledExactlyOnceWith({ id: 7, genre: 'Lo-fi' });
  });

  test('shows the error state without a genre, and none with one', async () => {
    const screen = renderWithProviders(<SongGenreTags image={song({})} />);

    await expect.element(page.getByText('Pick a genre to publish')).toBeInTheDocument();
    await expect.element(genreSelect()).toHaveAttribute('aria-invalid', 'true');

    (await screen).rerender(<SongGenreTags image={song({ genre: 'Rock' })} />);
    await expect.element(page.getByText('Pick a genre to publish')).not.toBeInTheDocument();
  });
});

describe('the song card tags', () => {
  test('shows each tag as a chip whose remove button removes it', async () => {
    renderWithProviders(
      <SongGenreTags
        image={song({ genre: 'Pop' }, [
          { id: 1, name: 'chill' },
          { id: 2, name: 'retro' },
        ])}
      />
    );

    await expect.element(page.getByText('chill')).toBeInTheDocument();
    await page.getByRole('button', { name: 'Remove tag retro' }).click();

    expect(mocks.removeTag).toHaveBeenCalledExactlyOnceWith({ id: 7, tagId: 2 });
  });

  test('adds a typed tag on Enter, and a suggested one when picked', async () => {
    renderWithProviders(<SongGenreTags image={song({ genre: 'Pop' })} />);
    const input = page.getByRole('textbox', { name: 'Add a tag' });

    await input.fill('Late Night');
    await userEvent.keyboard('{Enter}');
    expect(mocks.addTag).toHaveBeenLastCalledWith({ id: 7, name: 'late night' });

    await input.fill('ni');
    await page.getByRole('option', { name: 'night drive' }).click();
    expect(mocks.addTag).toHaveBeenLastCalledWith({ id: 7, name: 'night drive' });
  });

  test('hides the add control at five tags', async () => {
    const five = [1, 2, 3, 4, 5].map((id) => ({ id, name: `t${id}` }));
    renderWithProviders(<SongGenreTags image={song({ genre: 'Pop' }, five)} />);

    await expect.element(page.getByText('t5')).toBeInTheDocument();
    await expect.element(page.getByRole('textbox', { name: 'Add a tag' })).not.toBeInTheDocument();
  });
});
