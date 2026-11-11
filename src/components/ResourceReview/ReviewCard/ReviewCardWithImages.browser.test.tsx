import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ResourceReviewPagedModel } from '~/types/router';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../../test/component-setup';

const state = vi.hoisted(() => ({ inView: true }));
vi.mock('react-intersection-observer', () => ({
  useInView: () => ({ ref: () => undefined, inView: state.inView }),
}));

const useReviewImages = vi.hoisted(() => vi.fn());
vi.mock('~/components/ResourceReview/useReviewImages', () => ({ useReviewImages }));

vi.mock('~/components/ResourceReview/ReviewCard/ReviewCard', () => ({
  ReviewCard: ({ hiddenImageCount }: { hiddenImageCount?: number }) => (
    <div data-testid="card" data-hidden={hiddenImageCount} />
  ),
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

const lastCall = () => useReviewImages.mock.calls.at(-1)!;

beforeEach(() => {
  state.inView = true;
  useReviewImages.mockReset();
  useReviewImages.mockReturnValue({
    images: [],
    flatData: [],
    isSuccess: false,
    isError: false,
  });
});

describe('ReviewCardWithImages', () => {
  test('asks for the review’s own images, whether or not it has a post', async () => {
    await renderWithProviders(<ReviewCardWithImages review={makeReview({ postId: 55 })} />);
    await vi.waitFor(() => expect(lastCall()[1]).toEqual({ enabled: true }));
    expect(lastCall()[0]).toEqual({ reviewId: 7, limit: 9 });

    useReviewImages.mockClear();
    await renderWithProviders(<ReviewCardWithImages review={makeReview({ postId: null })} />);
    await vi.waitFor(() => expect(lastCall()[1]).toEqual({ enabled: true }));
    expect(lastCall()[0]).toEqual({ reviewId: 7, limit: 9 });
  });

  test('tells the card how many fetched images the preferences hid', async () => {
    useReviewImages.mockReturnValue({
      images: [{ id: 1 }],
      flatData: [{ id: 1 }, { id: 2 }, { id: 3 }],
      isSuccess: true,
      isError: false,
    });
    await renderWithProviders(<ReviewCardWithImages review={makeReview()} />);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="card"]')?.getAttribute('data-hidden')).toBe('2')
    );
  });

  test('reports nothing hidden while the viewer’s preferences are still loading', async () => {
    useReviewImages.mockReturnValue({
      images: [],
      flatData: [{ id: 1 }, { id: 2 }],
      isLoading: true,
      isSuccess: false,
      isError: false,
    });
    await renderWithProviders(<ReviewCardWithImages review={makeReview()} />);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="card"]')?.getAttribute('data-hidden')).toBe('0')
    );
  });

  test('does not load while out of view', async () => {
    state.inView = false;
    await renderWithProviders(<ReviewCardWithImages review={makeReview()} />);
    expect(useReviewImages.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
  });

  test('does not load for a review with no images', async () => {
    await renderWithProviders(<ReviewCardWithImages review={makeReview({ imageCount: 0 })} />);
    expect(useReviewImages.mock.calls.every(([, options]) => options.enabled === false)).toBe(true);
  });

  describe.each([
    ['succeeds', { isSuccess: true, isError: false }],
    ['fails', { isSuccess: false, isError: true }],
  ])('when a card’s query %s', (_, settled) => {
    test('it frees its slot for the next waiting card, which stays disabled until then', async () => {
      // Cards are told apart in the mock's calls by their review's id.
      const cards = Array.from({ length: MAX_CONCURRENT_IMAGE_LOADS + 1 }, (_, i) =>
        makeReview({ id: 1000 + i })
      );
      const waitingId = 1000 + MAX_CONCURRENT_IMAGE_LOADS;
      const callsFor = (reviewId: number) =>
        useReviewImages.mock.calls.filter(([query]) => query.reviewId === reviewId);
      const control = { settle: false };
      useReviewImages.mockImplementation((query) => ({
        images: [],
        flatData: [],
        ...(control.settle && query.reviewId === 1000
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
      expect(callsFor(waitingId).length).toBeGreaterThan(0);
      expect(callsFor(waitingId).every(([, options]) => options.enabled === false)).toBe(true);

      control.settle = true;
      await screen.rerender(list());
      await vi.waitFor(() => expect(callsFor(waitingId).at(-1)![1]).toEqual({ enabled: true }));
    });
  });
});
