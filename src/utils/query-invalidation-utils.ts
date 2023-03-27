import { debounce } from 'lodash';
import { trpc } from '~/utils/trpc';

type ToggleableContent = 'tag' | 'user';
export async function invalidateModeratedContent(
  queryUtils: ReturnType<typeof trpc.useContext>,
  changes: ToggleableContent[] | undefined = ['tag', 'user']
) {
  console.log('Invalidating moderated content...');
  const changedTag = changes.includes('tag');
  const changedUser = changes.includes('user');

  await queryUtils.model.invalidate();
  if (changedTag) await queryUtils.tag.invalidate();
  await queryUtils.post.invalidate();
  await queryUtils.image.invalidate();
  await queryUtils.review.invalidate();
}

export const invalidateModeratedContentDebounced = debounce(invalidateModeratedContent, 1000);
