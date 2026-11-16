import { useEffect } from 'react';
import { useController } from 'react-hook-form';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as MoreFromCreator from '~/components/Music/SongDetail/useMoreFromCreator';
import type * as FormModule from '~/libs/form';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The comment editor's form lifecycle: what the reader sees after posting and after cancelling.
 * The rich-text editor is replaced by a textarea that, like the real one, reports its empty HTML
 * back as a change when the form clears it; that report re-validated an emptied editor after a post.
 */

const create = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined)
);

vi.mock('~/libs/form', async (importOriginal) => ({
  ...(await importOriginal<typeof FormModule>()),
  InputRTE: ({ name, placeholder }: { name: string; placeholder?: string }) => {
    const { field, fieldState } = useController({ name });
    // Like RichTextEditor: a cleared value wipes the editor, which reports its empty HTML back, and
    // in the app that report can land after handleSubmit has finished.
    useEffect(() => {
      if (!field.value) setTimeout(() => field.onChange('<p></p>'));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [field.value]);
    return (
      <div>
        <textarea
          aria-label="comment"
          placeholder={placeholder}
          value={field.value}
          onChange={(e) => field.onChange(e.target.value)}
          onBlur={field.onBlur}
        />
        {fieldState.error && <p>{fieldState.error.message}</p>}
      </div>
    );
  },
}));
vi.mock('../CommentSectionContext', () => ({
  useCommentSection: () => ({ byId: new Map(), borderless: false }),
}));
vi.mock('../useCommentMutations', () => ({
  useCommentMutations: () => ({ create, edit: vi.fn(), saving: false }),
}));
vi.mock('~/components/Sticker/StickerPicker', () => ({ StickerPicker: () => null }));
vi.mock('~/components/CommentsV3/useSectionMute', () => ({ useSectionMute: vi.fn() }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('~/components/Music/SongDetail/useMoreFromCreator', async (importOriginal) => ({
  ...(await importOriginal<typeof MoreFromCreator>()),
  useMoreFromCreator: () => ({ songs: [], name: 'More from neonwave', isLoading: false }),
}));

import { SongCommentsProvider } from '~/components/Music/TimedComments/SongCommentsContext';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { CommentEditor } from '../CommentComposer';

beforeEach(() => create.mockClear());

describe('CommentEditor', () => {
  test('posting empties the editor without flagging it as empty', async () => {
    renderWithProviders(<CommentEditor autoFocus />);
    await userEvent.fill(page.getByLabelText('comment'), '<p>hello</p>');
    await page.getByRole('button', { name: 'Comment' }).click();

    await expect.poll(() => create.mock.calls.length).toBe(1);
    await expect.element(page.getByLabelText('comment')).toHaveValue('<p></p>');
    // Give a late re-validation the chance to render before asserting it never did.
    await new Promise((r) => setTimeout(r, 100));
    expect(document.body.textContent).not.toContain('Cannot be empty');
  });

  test('cancelling an empty reply closes it without an error', async () => {
    const onDone = vi.fn();
    renderWithProviders(<CommentEditor autoFocus onDone={onDone} />);
    await page.getByLabelText('comment').click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(onDone).toHaveBeenCalledOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(document.body.textContent).not.toContain('Cannot be empty');
  });
});

describe('CommentEditor on a song', () => {
  const song = {
    id: 1,
    url: 'song-1.mp3',
    metadata: { title: 'Midnight Arcade', duration: 178 },
    user: { id: 7, username: 'neonwave' },
  };
  const parent = { id: 50, depth: 0 } as never;
  const post = async () => {
    await userEvent.fill(page.getByLabelText('comment'), '<p>hello</p>');
    await page.getByRole('button', { name: 'Comment' }).click();
    await expect.poll(() => create.mock.calls.length).toBe(1);
  };

  beforeEach(() => {
    useMusicPlayerStore.getState().close();
    useMusicPlayerStore.getState().playTrack(songTrack(song));
    useMusicPlayheadStore.setState({ currentTime: 42.5, duration: 178 });
  });

  test('a new comment carries the playhead time the chip shows', async () => {
    renderWithProviders(
      <SongCommentsProvider song={song}>
        <CommentEditor autoFocus />
      </SongCommentsProvider>
    );
    await expect.element(page.getByRole('button', { name: 'at 0:42' })).toBeInTheDocument();
    await post();
    expect(create).toHaveBeenCalledWith('<p>hello</p>', null, 42);
  });

  test('a reply carries no time and shows no chip', async () => {
    renderWithProviders(
      <SongCommentsProvider song={song}>
        <CommentEditor parent={parent} autoFocus />
      </SongCommentsProvider>
    );
    await post();
    expect(create).toHaveBeenCalledWith('<p>hello</p>', { id: 50, depth: 0 }, undefined);
    expect(document.body.textContent).not.toContain('at 0:42');
  });

  test('a comment on anything else carries no time and shows no chip', async () => {
    renderWithProviders(<CommentEditor autoFocus />);
    await post();
    expect(create).toHaveBeenCalledWith('<p>hello</p>', null, undefined);
    expect(document.body.textContent).not.toContain('at 0:42');
  });
});
