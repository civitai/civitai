import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ImageUtils from '~/components/Image/image.utils';
import type { ResourceReviewPagedModel } from '~/types/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({ inView: true }));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => undefined, inView: state.inView }),
}));

const useQueryImages = vi.hoisted(() => vi.fn());
vi.mock('~/components/Image/image.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  useQueryImages,
}));

vi.mock('~/components/ResourceReview/ReviewCard/ReviewCard', () => ({
  ReviewCard: () => <div data-testid="card" />,
}));

import { MAX_CONCURRENT_IMAGE_LOADS } from './imageLoadLimiter';
import { ReviewCardWithImages } from './ReviewCardWithImages';

const makeReview = (overrides: Partial<ResourceReviewPagedModel> = {}) =>
  ({
    id: 7,
    modelVersionId: 2,
    postId: null,
    imageCount: 3,
    user: { id: 101 },
    ...overrides,
  } as ResourceReviewPagedModel);

const lastCall = () => useQueryImages.mock.calls.at(-1)!;

beforeEach(() => {
  state.inView = true;
  useQueryImages.mockReset();
  useQueryImages.mockReturnValue({ images: [], isSuccess: false, isError: false });
});

describe('ReviewCardWithImages', () => {
  test('a review with a post asks for that post’s images of the reviewed version', async () => {
    await renderWithProviders(<ReviewCardWithImages review={makeReview({ postId: 55 })} />);
    await vi.waitFor(() => expect(lastCall()[1]).toEqual({ enabled: true }));

    const filters = lastCall()[0];
    expect(filters).toMatchObject({ postId: 55, modelVersionId: 2, limit: 4 });
    expect(filters).not.toHaveProperty('userId');
  });

  test('a review without a post asks for the reviewer’s most reacted images of the version', async () => {
    await renderWithProviders(<ReviewCardWithImages review={makeReview()} />);
    await vi.waitFor(() => expect(lastCall()[1]).toEqual({ enabled: true }));

    const filters = lastCall()[0];
    expect(filters).toMatchObject({ userId: 101, modelVersionId: 2, limit: 4 });
    expect(filters).not.toHaveProperty('postId');
    expect(filters.sort).toBeTruthy();
  });

  test('does not load while out of view', async () => {
    state.inView = false;
    await renderWithProviders(<ReviewCardWithImages review={makeReview()} />);
    expect(useQueryImages.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
  });

  test('does not load for a review with no images', async () => {
    await renderWithProviders(<ReviewCardWithImages review={makeReview({ imageCount: 0 })} />);
    expect(useQueryImages.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
  });

  describe.each([
    ['succeeds', { isSuccess: true, isError: false }],
    ['fails', { isSuccess: false, isError: true }],
  ])('when a card’s query %s', (_, settled) => {
    test('it frees its slot for the next waiting card, which stays disabled until then', async () => {
      // Cards are told apart in the mock's calls by their reviewer's id.
      const cards = Array.from({ length: MAX_CONCURRENT_IMAGE_LOADS + 1 }, (_, i) =>
        makeReview({ id: i + 1, user: { id: 1000 + i } as ResourceReviewPagedModel['user'] })
      );
      const waitingUserId = 1000 + MAX_CONCURRENT_IMAGE_LOADS;
      const callsFor = (userId: number) =>
        useQueryImages.mock.calls.filter(([filters]) => filters.userId === userId);
      const control = { settle: false };
      useQueryImages.mockImplementation((filters) => ({
        images: [],
        ...(control.settle && filters.userId === 1000
          ? settled
          : { isSuccess: false, isError: false }),
      }));
      const list = () => (
        <>
          {cards.map((review) => (
            <ReviewCardWithImages key={review.id} review={review} />
          ))}
        </>
      );

      const screen = await renderWithProviders(list());
      await vi.waitFor(() => expect(callsFor(1000).at(-1)![1]).toEqual({ enabled: true }));
      expect(callsFor(waitingUserId).length).toBeGreaterThan(0);
      expect(callsFor(waitingUserId).every(([, options]) => options.enabled === false)).toBe(true);

      control.settle = true;
      await screen.rerender(list());
      await vi.waitFor(() => expect(callsFor(waitingUserId).at(-1)![1]).toEqual({ enabled: true }));
    });
  });
});
