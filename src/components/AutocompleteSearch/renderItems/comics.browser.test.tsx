import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';
import { ComicsSearchItem } from '~/components/AutocompleteSearch/renderItems/comics';

// The avatar needs the app's providers and plays no part in the cover.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));

const COVER = 'https://image.example/comic-cover.jpeg';
const hit = (nsfwLevel: number, coverImageNsfwLevel: number | null) =>
  ({
    id: 1,
    objectID: '1',
    name: 'Sky Knights',
    genre: 'Fantasy',
    coverImageUrl: COVER,
    coverImageNsfwLevel,
    nsfwLevel,
    user: { id: 7, username: 'someone', deletedAt: null, image: null, profilePictureId: null },
    stats: { chapterCount: 1, followerCount: 0 },
    _highlightResult: {},
  } as never);

const coverShown = () =>
  Array.from(document.querySelectorAll('img')).some((img) => img.src.includes('comic-cover'));

describe('comics autocomplete cover', () => {
  test('a cover above the comic’s own level is hidden', async () => {
    await renderWithProviders(<ComicsSearchItem value="1" label="Sky Knights" hit={hit(1, 4)} />);
    await expect.element(page.getByTestId('comic-cover-hidden')).toBeInTheDocument();
    expect(coverShown()).toBe(false);
  });

  test('a safe cover on a mature comic is hidden', async () => {
    await renderWithProviders(<ComicsSearchItem value="1" label="Sky Knights" hit={hit(4, 1)} />);
    await expect.element(page.getByTestId('comic-cover-hidden')).toBeInTheDocument();
    expect(coverShown()).toBe(false);
  });

  test('an unrated comic with an unrated cover is hidden', async () => {
    await renderWithProviders(
      <ComicsSearchItem value="1" label="Sky Knights" hit={hit(0, null)} />
    );
    await expect.element(page.getByTestId('comic-cover-hidden')).toBeInTheDocument();
    expect(coverShown()).toBe(false);
  });

  test('a safe cover on a safe comic is shown', async () => {
    await renderWithProviders(<ComicsSearchItem value="1" label="Sky Knights" hit={hit(1, 1)} />);
    await expect.poll(coverShown).toBe(true);
  });
});
