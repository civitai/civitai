import { Context } from '~/server/createContext';
import { GetAllReviewsInput } from '~/server/schema/review.schema';
import { getAllReviewsSelect } from '~/server/selectors/review.selector';
import { getReviews } from '~/server/services/review.service';

export const getReviewsInfiniteHandler = async ({
  input,
  ctx,
}: {
  input: GetAllReviewsInput;
  ctx: Context;
}) => {
  input.limit = input.limit ?? 20;
  const limit = input.limit + 1;

  const reviews = await getReviews({
    input: { ...input, limit },
    user: ctx.user,
    select: getAllReviewsSelect,
  });

  let nextCursor: number | undefined;
  if (reviews.length > input.limit) {
    const nextItem = reviews.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    reviews: reviews.map(({ imagesOnReviews, ...review }) => ({
      ...review,
      images: imagesOnReviews.map(({ image }) => image),
    })),
  };
};
