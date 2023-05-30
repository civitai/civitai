import { debounce } from 'lodash-es';
import { trpc } from '~/utils/trpc';

type ToggleableContent = 'tag' | 'user';
export async function invalidateModeratedContent(
  queryUtils: ReturnType<typeof trpc.useContext>,
  changes: ToggleableContent[] | undefined = ['tag', 'user']
) {
  console.log('Invalidating moderated content...');
  const changedTag = changes.includes('tag');
  // const changedUser = changes.includes('user');

  // await queryUtils.model.invalidate();
  // #region [invalidate all model caches]
  // This  may be a temporary measure, implemented so as to avoid invalidating the models index page when the browsing mode changes
  await queryUtils.model.getById.invalidate();
  await queryUtils.model.getAll.invalidate();
  // await queryUtils.model.getInfinite.invalidate(); // not this one
  await queryUtils.model.getAllPagedSimple.invalidate();
  await queryUtils.model.getAllWithVersions.invalidate();
  await queryUtils.model.getByIdWithVersions.invalidate();
  await queryUtils.model.getVersions.invalidate();
  await queryUtils.model.getMyDraftModels.invalidate();
  await queryUtils.model.getModelReportDetails.invalidate();
  await queryUtils.model.getModelDetailsForReview.invalidate();
  await queryUtils.model.getDownloadCommand.invalidate();
  await queryUtils.model.getSimple.invalidate();
  await queryUtils.model.getByCategory.invalidate();
  await queryUtils.model.getWithCategoriesSimple.invalidate();
  await queryUtils.model.getAssociatedModelsCardData.invalidate();
  await queryUtils.model.getAssociatedModelsSimple.invalidate();
  // #endregion

  if (changedTag) await queryUtils.tag.invalidate();
  await queryUtils.post.invalidate();
  await queryUtils.image.invalidate();
  // await queryUtils.review.invalidate();
}

export const invalidateModeratedContentDebounced = debounce(invalidateModeratedContent, 1000);
