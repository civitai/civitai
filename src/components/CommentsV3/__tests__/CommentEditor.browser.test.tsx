import { useEffect } from 'react';
import { useController } from 'react-hook-form';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as FormModule from '~/libs/form';
import { renderWithProviders } from '../../../../test/component-setup';

/**
 * The comment editor's form lifecycle: what the reader sees after posting and after cancelling.
 * The rich-text editor is replaced by a textarea that, like the real one, reports its empty HTML
 * back as a change when the form clears it; that report re-validated an emptied editor after a post.
 */

const create = vi.hoisted(() => vi.fn(async () => undefined));

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
vi.mock('~/components/CommentsV2/Comment/CreateComment', () => ({ useSectionMute: vi.fn() }));
vi.mock('~/components/UserAvatar/UserAvatar', () => ({ UserAvatar: () => null }));

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
