import { TagTarget } from '@prisma/client';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { TagSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

export function useCategoryTags({ entityType }: { entityType: TagTarget }) {
  let sort: TagSort | undefined;
  if (entityType === TagTarget.Model) sort = TagSort.MostModels;
  else if (entityType === TagTarget.Image) sort = TagSort.MostImages;
  else if (entityType === TagTarget.Post) sort = TagSort.MostPosts;
  else if (entityType === TagTarget.Article) sort = TagSort.MostArticles;

  const { data, isLoading } = trpc.tag.getAll.useQuery({
    entityType: [entityType],
    sort,
    unlisted: false,
    categories: true,
    limit: 100,
    include: ['nsfwLevel'],
  });

  const tags = !data ? undefined : data.items;
  const { items, loadingPreferences } = useApplyHiddenPreferences({ type: 'tags', data: tags });

  return { data: items, isLoading: isLoading || loadingPreferences };
}
