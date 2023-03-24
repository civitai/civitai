import { trpc } from '~/utils/trpc';

export async function invalidateModeratedContent(queryUtils: ReturnType<typeof trpc.useContext>) {
  await queryUtils.model.invalidate();
  await queryUtils.tag.invalidate();
  await queryUtils.post.invalidate();
  await queryUtils.image.invalidate();
  await queryUtils.review.invalidate();
}
