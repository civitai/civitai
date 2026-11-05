import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { PageModal } from '~/components/Dialog/Templates/PageModal';
import { StorylineStageOverlay } from '~/components/Storyline/StorylineDetail';

/**
 * In the reader, a chapter's author edits the caption on each of their images and the chapter
 * title in place, through the same writes the post editor uses. Nobody else sees the controls.
 */

type MutationOptions = {
  onSuccess?: (data: unknown, vars: unknown) => unknown;
  onError?: (error: Error) => unknown;
};

const mocks = vi.hoisted(() => ({
  userId: 1 as number | undefined,
  captions: {} as Record<number, string>,
  setCaption: vi.fn(),
  updatePost: vi.fn(),
  fail: false,
  notifyError: vi.fn(),
  // Stable spies: the proxy's default useUtils mints a fresh vi.fn per access, so it can't be asserted.
  invalidate: {
    getPath: vi.fn(async () => undefined),
    getForPosts: vi.fn(async () => undefined),
    postGet: vi.fn(async () => undefined),
  },
}));

function mutation(spy: (vars: unknown) => void) {
  return (options: MutationOptions) => ({
    mutate: (vars: unknown) => {
      spy(vars);
      if (mocks.fail) void options.onError?.(new Error('nope'));
      else void options.onSuccess?.(null, vars);
    },
    isPending: false,
  });
}

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'storyline.setImageCaption': { useMutation: mutation((v) => mocks.setCaption(v)) },
        'post.update': { useMutation: mutation((v) => mocks.updatePost(v)) },
      },
      {
        useUtils: () => ({
          storyline: {
            getPath: { invalidate: mocks.invalidate.getPath },
            getForPosts: { invalidate: mocks.invalidate.getForPosts },
          },
          post: { get: { invalidate: mocks.invalidate.postGet } },
        }),
      }
    ),
  };
});
vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showErrorNotification: mocks.notifyError,
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.userId ? { id: mocks.userId } : null),
}));
vi.mock('~/components/Storyline/StorylineEndOfChapter', () => ({
  StorylineEndOfChapter: () => null,
}));
vi.mock('~/components/Storyline/StorylineModeProvider', () => ({
  useStorylineMode: () => ({
    active: true,
    endOpen: false,
    setEndOpen: () => undefined,
    // Image 7 is in chapter 10 by user 1; image 8 in chapter 11 by user 2. User 3 owns the
    // storyline and wrote neither chapter.
    chapterIdOfImage: (imageId: number) => ({ 7: 10, 8: 11 }[imageId]),
    path: {
      storyline: { id: 3, userId: 3 },
      captions: mocks.captions,
      chapters: [
        { chapterId: 10, depth: 0, post: { id: 41, title: 'The Gate', userId: 1 } },
        { chapterId: 11, depth: 1, post: { id: 42, title: 'The Road', userId: 2 } },
      ],
    },
  }),
}));

const editCaption = () => page.getByRole('button', { name: 'Edit caption' });
const addCaption = () => page.getByRole('button', { name: 'Add caption' });
const editTitle = () => page.getByRole('button', { name: 'Edit title' });

beforeEach(() => {
  mocks.userId = 1;
  mocks.captions = { 7: 'They reach the gate.' };
  mocks.setCaption.mockReset();
  mocks.updatePost.mockReset();
  mocks.fail = false;
  mocks.notifyError.mockReset();
  Object.values(mocks.invalidate).forEach((spy) => spy.mockClear());
});

const captionBox = () => page.getByRole('textbox', { name: 'Caption (shown in the story)' });
const titleBox = () => page.getByRole('textbox', { name: 'Chapter title' });
const save = () => page.getByRole('button', { name: 'Save' });
const cancel = () => page.getByRole('button', { name: 'Cancel' });

describe('StorylineStageOverlay: who sees the edit controls', () => {
  test('the chapter author sees Edit caption and Edit title', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);

    await expect.element(editCaption()).toBeVisible();
    await expect.element(editTitle()).toBeVisible();
    await expect.element(page.getByText('They reach the gate.')).toBeVisible();
  });

  test('an image with no caption offers Add caption', async () => {
    mocks.captions = {};
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);

    await expect.element(addCaption()).toBeVisible();
  });

  test.each([
    ['another signed-in user', 4],
    ['a signed-out reader', undefined],
    ['the author of a different chapter', 2],
    ['the storyline owner', 3],
  ])('%s sees no edit controls on chapter 10', async (_name, userId) => {
    mocks.userId = userId;
    mocks.captions = { 7: 'A caption.' };
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);

    await expect.element(page.getByText('A caption.')).toBeVisible();
    for (const control of [editCaption(), addCaption(), editTitle()])
      expect(control.elements()).toHaveLength(0);
  });
});

describe('StorylineStageOverlay: saving', () => {
  test('a caption saves through storyline.setImageCaption', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editCaption().click();

    const box = page.getByRole('textbox', { name: 'Caption (shown in the story)' });
    await expect.element(box).toHaveValue('They reach the gate.');
    await userEvent.clear(box);
    await userEvent.type(box, 'The gate is shut.');
    await page.getByRole('button', { name: 'Save' }).click();

    expect(mocks.setCaption).toHaveBeenCalledExactlyOnceWith({
      imageId: 7,
      content: 'The gate is shut.',
    });
    await expect.element(editCaption()).toBeVisible();
    expect(mocks.invalidate.getPath).toHaveBeenCalledOnce();
  });

  test('the title saves through post.update on the chapter post', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editTitle().click();

    const input = page.getByRole('textbox', { name: 'Chapter title' });
    await expect.element(input).toHaveValue('The Gate');
    await userEvent.clear(input);
    await userEvent.type(input, 'The Iron Gate{Enter}');

    expect(mocks.updatePost).toHaveBeenCalledExactlyOnceWith({ id: 41, title: 'The Iron Gate' });
    expect(mocks.setCaption).not.toHaveBeenCalled();
    await expect.element(editTitle()).toBeVisible();
    expect(mocks.invalidate.getPath).toHaveBeenCalledOnce();
    expect(mocks.invalidate.getForPosts).toHaveBeenCalledOnce();
    expect(mocks.invalidate.postGet).toHaveBeenCalledExactlyOnceWith({ id: 41 });
  });

  test('saving the title with Enter does not submit the page', async () => {
    // Without preventDefault the form's native submit reloads the page under the reader.
    let nativeSubmitBlocked: boolean | undefined;
    const onSubmit = (event: Event) => {
      nativeSubmitBlocked = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener('submit', onSubmit);
    try {
      renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
      await editTitle().click();
      await userEvent.type(titleBox(), ' Two{Enter}');

      await expect.poll(() => nativeSubmitBlocked).toBe(true);
    } finally {
      document.removeEventListener('submit', onSubmit);
    }
  });

  test('Cancel leaves the caption unsaved', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editCaption().click();
    await userEvent.type(
      page.getByRole('textbox', { name: 'Caption (shown in the story)' }),
      ' More.'
    );
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(mocks.setCaption).not.toHaveBeenCalled();
    await expect.element(page.getByText('They reach the gate.')).toBeVisible();
  });
});

describe('StorylineStageOverlay: caption save branches', () => {
  test('a cleared caption is sent empty, which removes it', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editCaption().click();
    await userEvent.clear(captionBox());
    await save().click();

    expect(mocks.setCaption).toHaveBeenCalledExactlyOnceWith({ imageId: 7, content: '' });
  });

  test('unchanged text sends nothing and closes the editor', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editCaption().click();
    await save().click();

    await expect.element(editCaption()).toBeVisible();
    expect(captionBox().elements()).toHaveLength(0);
    expect(mocks.setCaption).not.toHaveBeenCalled();
  });

  test('a failed save keeps the editor open with the text', async () => {
    mocks.fail = true;
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editCaption().click();
    await userEvent.type(captionBox(), ' Again.');
    await save().click();

    expect(mocks.setCaption).toHaveBeenCalledOnce();
    expect(mocks.notifyError).toHaveBeenCalledOnce();
    expect(mocks.invalidate.getPath).not.toHaveBeenCalled();
    await expect.element(captionBox()).toHaveValue('They reach the gate. Again.');
  });
});

describe('StorylineStageOverlay: title save branches', () => {
  test('a blank title is saved as null and the editor closes', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editTitle().click();
    await userEvent.clear(titleBox());
    await save().click();

    expect(mocks.updatePost).toHaveBeenCalledExactlyOnceWith({ id: 41, title: null });
    await expect.element(editTitle()).toBeVisible();
    expect(titleBox().elements()).toHaveLength(0);
  });

  test('Cancel closes the title editor without saving', async () => {
    renderWithProviders(<StorylineStageOverlay isLastImage={false} imageId={7} />);
    await editTitle().click();
    await userEvent.type(titleBox(), ' Two');
    await cancel().click();

    await expect.element(editTitle()).toBeVisible();
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });
});

describe('StorylineStageOverlay: Escape inside the reader', () => {
  // The reader is a Mantine modal that closes on any Escape it sees on the window.
  function renderInReader() {
    const onClose = vi.fn();
    renderWithProviders(
      <PageModal opened onClose={onClose} withinPortal={false}>
        <StorylineStageOverlay isLastImage={false} imageId={7} />
      </PageModal>
    );
    return onClose;
  }

  test.each([
    ['caption', () => editCaption().click(), captionBox],
    ['title', () => editTitle().click(), titleBox],
  ])('Escape in the %s editor cancels it and leaves the reader open', async (_n, open, box) => {
    const onClose = renderInReader();
    await open();
    await userEvent.type(box(), ' edited');
    await userEvent.keyboard('{Escape}');

    await expect.element(editCaption()).toBeVisible();
    expect(box().elements()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.setCaption).not.toHaveBeenCalled();
    expect(mocks.updatePost).not.toHaveBeenCalled();
  });

  // Positive control: the same modal does close on an Escape from outside an editor.
  test('Escape outside an editor closes the reader', async () => {
    const onClose = renderInReader();
    await expect.element(editCaption()).toBeVisible();
    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});
