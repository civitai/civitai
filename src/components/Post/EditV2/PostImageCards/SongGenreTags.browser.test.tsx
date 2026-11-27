// The real cascade, so sizes are measured against the styles the app renders.
import '../../../../../test/cascade-layer-order.css';
import '@mantine/core/styles.layer.css';
import '~/styles/globals.css';
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
  post: { publishedAt: null as Date | null },
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'post.setSongGenre': { useMutation: () => ({ mutate: mocks.setGenre, isPending: false }) },
      'post.addSongTag': { useMutation: () => ({ mutate: mocks.addTag, isPending: false }) },
      'post.removeSongTag': { useMutation: () => ({ mutate: mocks.removeTag, isPending: false }) },
      'post.searchSongTags': {
        useQuery: () => ({
          data: [
            { id: 3, name: 'night drive' },
            { id: 4, name: 'guitarist' },
          ],
        }),
      },
    }),
  };
});
vi.mock('~/components/Post/EditV2/PostEditProvider', async (orig) => ({
  ...(await orig<typeof PostEditProviderMod>()),
  usePostEditStore: (selector: (state: unknown) => unknown) =>
    selector({ updateImage: mocks.updateImage, post: mocks.post }),
}));

// eslint-disable-next-line import/first
import { SongGenreSelect, SongTags } from '~/components/Post/EditV2/PostImageCards/SongGenreTags';

/** A song in the editor: its genre is the payload's `genre` (Track.genre), not its metadata. */
const song = ({ genre }: { genre?: string }, songTags: { id: number; name: string }[] = []) =>
  ({
    id: 7,
    type: 'audio',
    nsfwLevel: 2,
    metadata: { duration: 120 },
    genre: genre ?? null,
    songTags,
  } as unknown as PostEditImageDetail);

const genreSelect = () => page.getByRole('textbox', { name: 'Genre' });
/** Opens the "+ Tag" badge's field, as a click does on an image's tags. */
const openTagField = async () => {
  await page.getByText('Tag', { exact: true }).click();
  return page.getByRole('textbox', { name: 'Add a tag' });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.publishedAt = null;
});

describe('the song card genre select', () => {
  test('lists the genres and saves the one picked', async () => {
    renderWithProviders(<SongGenreSelect image={song({ genre: 'Pop' })} />);

    await genreSelect().click();
    await expect.element(page.getByRole('option', { name: 'Synthwave' })).toBeInTheDocument();
    await page.getByRole('option', { name: 'Lo-fi' }).click();

    expect(mocks.setGenre).toHaveBeenCalledExactlyOnceWith({ id: 7, genre: 'Lo-fi' });
  });

  test('filters the genres by what is typed', async () => {
    renderWithProviders(<SongGenreSelect image={song({})} />);

    await genreSelect().fill('hou');
    await expect.element(page.getByRole('option', { name: 'House' })).toBeVisible();
    await expect.element(page.getByRole('option', { name: 'Jazz' })).not.toBeInTheDocument();
  });

  test('without a genre, typed search text keeps the normal colour while the message is red', async () => {
    await renderWithProviders(<SongGenreSelect image={song({})} />);
    await genreSelect().fill('ja');

    const message = page.getByText('Pick a genre to publish').element();
    const input = genreSelect().element();
    expect(getComputedStyle(input).color).not.toBe(getComputedStyle(message).color);
    expect(getComputedStyle(input).borderColor).toBe(getComputedStyle(message).color);
  });

  test('shows the error state without a genre, and none with one', async () => {
    const screen = renderWithProviders(<SongGenreSelect image={song({})} />);

    await expect.element(page.getByText('Pick a genre to publish')).toBeInTheDocument();
    await expect.element(genreSelect()).toHaveAttribute('aria-invalid', 'true');

    (await screen).rerender(<SongGenreSelect image={song({ genre: 'Rock' })} />);
    await expect.element(page.getByText('Pick a genre to publish')).not.toBeInTheDocument();
  });

  test('asks for no genre on a song in a post that is already live, as publishing does not', async () => {
    mocks.post.publishedAt = new Date(Date.now() - 60_000);
    renderWithProviders(<SongGenreSelect image={song({})} />);
    await expect.element(genreSelect()).toBeVisible();
    await expect.element(page.getByText('Pick a genre to publish')).not.toBeInTheDocument();
  });

  test('still asks on a post scheduled for later', async () => {
    mocks.post.publishedAt = new Date(Date.now() + 86_400_000);
    renderWithProviders(<SongGenreSelect image={song({})} />);
    await expect.element(page.getByText('Pick a genre to publish')).toBeVisible();
  });
});

describe('the song card tags', () => {
  test("shows the song's rating, and the add field only once + Tag is clicked", async () => {
    renderWithProviders(<SongTags image={song({ genre: 'Pop' })} />);

    await expect.element(page.getByText('PG-13')).toBeVisible();
    await expect.element(page.getByRole('textbox', { name: 'Add a tag' })).not.toBeInTheDocument();
    await expect.element(await openTagField()).toHaveFocus();
  });

  test('shows each tag as a chip whose remove button removes it', async () => {
    renderWithProviders(
      <SongTags
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

  test('Enter adds the typed text when no suggestion is highlighted, and clears the field', async () => {
    renderWithProviders(<SongTags image={song({ genre: 'Pop' })} />);
    const input = await openTagField();

    await input.fill('Late Night');
    await userEvent.keyboard('{Enter}');

    expect(mocks.addTag).toHaveBeenCalledExactlyOnceWith({ id: 7, name: 'late night' });
    await expect.element(input).toHaveValue('');
  });

  test('Enter on a highlighted suggestion adds only that suggestion', async () => {
    renderWithProviders(<SongTags image={song({ genre: 'Pop' })} />);
    const input = await openTagField();

    await input.fill('guitari');
    await expect.element(page.getByRole('option', { name: 'guitarist' })).toBeVisible();
    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(mocks.addTag).toHaveBeenCalledExactlyOnceWith({ id: 7, name: 'guitarist' });
    await expect.element(input).toHaveValue('');
  });

  test('clicking a suggestion adds it', async () => {
    renderWithProviders(<SongTags image={song({ genre: 'Pop' })} />);

    await (await openTagField()).fill('ni');
    await page.getByRole('option', { name: 'night drive' }).click();

    expect(mocks.addTag).toHaveBeenCalledExactlyOnceWith({ id: 7, name: 'night drive' });
  });

  test('each remove button is at least 24px square', async () => {
    await renderWithProviders(
      <SongTags image={song({ genre: 'Pop' }, [{ id: 1, name: 'chill' }])} />
    );
    await expect.element(page.getByRole('button', { name: 'Remove tag chill' })).toBeVisible();

    const rect = page
      .getByRole('button', { name: 'Remove tag chill' })
      .element()
      .getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(24);
    expect(rect.height).toBeGreaterThanOrEqual(24);
  });

  test('at five tags the add control gives way to a 5/5 note', async () => {
    const five = [1, 2, 3, 4, 5].map((id) => ({ id, name: `t${id}` }));
    renderWithProviders(<SongTags image={song({ genre: 'Pop' }, five)} />);

    await expect.element(page.getByText('t5')).toBeInTheDocument();
    await expect.element(page.getByText('5/5 tags')).toBeVisible();
    await expect.element(page.getByText('Tag', { exact: true })).not.toBeInTheDocument();
  });
});
