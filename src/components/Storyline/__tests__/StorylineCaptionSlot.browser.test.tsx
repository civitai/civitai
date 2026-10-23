import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import { StorylineCaptionSlot } from '~/components/Storyline/editor/StorylineCaptionSlot';

/**
 * The post editor writes captions only for a post that belongs to a storyline, and only for its
 * author: a draft started from the storyline flow, or a post that is already a chapter.
 */

type MutationOptions = { onSuccess?: (data: unknown, vars: { content: string }) => void };

const mocks = vi.hoisted(() => ({
  pending: null as unknown,
  forPosts: {} as Record<number, unknown>,
  enabled: true,
  userId: 1 as number | undefined,
  setCaption: vi.fn(),
  fail: false,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy({
      'storyline.getPendingForPost': {
        useQuery: () => ({ data: mocks.pending, isLoading: false }),
      },
      'storyline.getForPosts': {
        useQuery: (_input: unknown, options?: { enabled?: boolean }) => ({
          data: options?.enabled === false ? undefined : mocks.forPosts,
          isLoading: false,
        }),
      },
      'storyline.setImageCaption': {
        useMutation: (options: MutationOptions & { onError?: (e: Error) => void }) => {
          const [state, setState] = useState<'idle' | 'success' | 'error'>('idle');
          return {
            mutate: (vars: { imageId: number; content: string }) => {
              mocks.setCaption(vars);
              if (mocks.fail) {
                setState('error');
                options.onError?.(new Error('nope'));
              } else {
                setState('success');
                options.onSuccess?.(null, vars);
              }
            },
            reset: () => setState('idle'),
            isPending: false,
            isSuccess: state === 'success',
            isError: state === 'error',
          };
        },
      },
    }),
  };
});
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ storylines: mocks.enabled }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => (mocks.userId ? { id: mocks.userId } : null),
}));

const draft = { id: 41, user: { id: 1 }, publishedAt: null };
const published = { ...draft, publishedAt: new Date('2026-01-01') };
const image = {
  id: 7,
  url: 'https://example.invalid/a.jpg',
  type: 'image' as const,
  metadata: { width: 400, height: 300 },
} as never;
const pendingLink = {
  postId: 41,
  storyline: { id: 2, title: 'The Patch' },
  parentChapter: null,
};

const box = () => page.getByRole('textbox', { name: 'Caption for this picture' });

beforeEach(() => {
  mocks.pending = null;
  mocks.forPosts = {};
  mocks.enabled = true;
  mocks.userId = 1;
  mocks.fail = false;
  mocks.setCaption.mockReset();
});

describe('StorylineCaptionSlot: where the box appears', () => {
  test('a draft started from a storyline gets the caption box', async () => {
    mocks.pending = pendingLink;
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await expect.element(box()).toBeVisible();
    await expect
      .element(box())
      .toHaveAttribute('placeholder', 'What happens in this picture? (optional)');
  });

  test('a post that is already a chapter gets it too', async () => {
    mocks.forPosts = { 41: { storylineId: 2, title: 'The Patch', depth: 0 } };
    renderWithProviders(<StorylineCaptionSlot post={published} image={image} />);

    await expect.element(box()).toBeVisible();
  });

  test.each([
    ['an ordinary post', () => undefined],
    ['storylines switched off', () => (mocks.enabled = false)],
    [
      'a viewer who is not the author',
      () => {
        mocks.pending = pendingLink;
        mocks.userId = 2;
      },
    ],
  ])('%s gets no box', async (_name, setup) => {
    setup();
    renderWithProviders(
      <>
        <span>rendered</span>
        <StorylineCaptionSlot post={draft} image={image} />
      </>
    );

    // An absence read before the first commit passes for free; wait for the same commit first.
    await expect.element(page.getByText('rendered')).toBeVisible();
    expect(box().elements()).toHaveLength(0);
  });
});

describe('StorylineCaptionSlot: writing', () => {
  beforeEach(() => {
    mocks.pending = pendingLink;
  });

  test('leaving the box saves the trimmed text once, with a Saved tick', async () => {
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await box().fill('  The door was open.  ');
    expect(mocks.setCaption).not.toHaveBeenCalled();
    (box().element() as HTMLTextAreaElement).blur();

    await vi.waitFor(() => expect(mocks.setCaption).toHaveBeenCalledTimes(1));
    expect(mocks.setCaption).toHaveBeenCalledWith({ imageId: 7, content: 'The door was open.' });
    await expect.element(page.getByText('Saved')).toBeVisible();

    // Unchanged text is not sent again.
    (box().element() as HTMLTextAreaElement).focus();
    (box().element() as HTMLTextAreaElement).blur();
    expect(mocks.setCaption).toHaveBeenCalledTimes(1);
  });

  test('emptying a saved caption sends an empty string, which the server turns into no row', async () => {
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await box().fill('Hello');
    (box().element() as HTMLTextAreaElement).blur();
    await vi.waitFor(() => expect(mocks.setCaption).toHaveBeenCalledTimes(1));

    await box().fill('');
    (box().element() as HTMLTextAreaElement).blur();
    await vi.waitFor(() => expect(mocks.setCaption).toHaveBeenCalledTimes(2));
    expect(mocks.setCaption).toHaveBeenLastCalledWith({ imageId: 7, content: '' });
  });

  test('an untouched empty box saves nothing', async () => {
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await expect.element(box()).toBeVisible();
    (box().element() as HTMLTextAreaElement).focus();
    (box().element() as HTMLTextAreaElement).blur();
    expect(mocks.setCaption).not.toHaveBeenCalled();
  });

  test('a refused save says so and the next blur tries again', async () => {
    mocks.fail = true;
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await box().fill('Hello');
    (box().element() as HTMLTextAreaElement).blur();
    await expect.element(page.getByText('Not saved')).toBeVisible();

    (box().element() as HTMLTextAreaElement).focus();
    (box().element() as HTMLTextAreaElement).blur();
    await vi.waitFor(() => expect(mocks.setCaption).toHaveBeenCalledTimes(2));
  });

  test('the counter appears at 400 characters and the box stops at 500', async () => {
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await box().fill('a'.repeat(399));
    expect(page.getByText(/\/ 500/).elements()).toHaveLength(0);

    await box().fill('a'.repeat(462));
    await expect.element(page.getByText('462 / 500')).toBeVisible();

    await box().fill('a'.repeat(560));
    await expect.element(page.getByText('500 / 500')).toBeVisible();
  });

  test('Preview shows the typed text as the reader sees it, and needs text', async () => {
    renderWithProviders(<StorylineCaptionSlot post={draft} image={image} />);

    await expect.element(page.getByRole('button', { name: 'Preview' })).toBeDisabled();
    await box().fill('The door was open.');
    await page.getByRole('button', { name: 'Preview' }).click();

    await expect
      .element(page.getByTestId('storyline-caption-preview').getByTestId('storyline-caption-note'))
      .toHaveTextContent('The door was open.');
  });
});
