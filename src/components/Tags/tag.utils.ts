import { TagTarget } from '~/shared/utils/prisma/enums';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';
import type { GetTagsForReviewInput } from '~/server/schema/tag.schema';

export function useCategoryTags({ entityType }: { entityType: TagTarget }) {
  // Sort is deliberately omitted: `tag.getAll` derives it from `entityType` when
  // absent, and sending it explicitly would suppress that default rather than
  // agree with it — the server's ladder is behind `if (!sort)`.
  const { data, isLoading } = trpc.tag.getAll.useQuery({
    entityType: [entityType],
    unlisted: false,
    categories: true,
    limit: 100,
    include: ['nsfwLevel'],
  });

  const tags = !data ? undefined : data.items;
  const { items, loadingPreferences } = useApplyHiddenPreferences({ type: 'tags', data: tags });

  return { data: items, isLoading: isLoading || loadingPreferences };
}

export function useQueryTagsForReview({
  reviewType,
}: Omit<GetTagsForReviewInput, 'limit' | 'page'>) {
  const { data, isLoading, ...rest } = trpc.tag.getTagsForReview.useQuery({
    reviewType,
    limit: 100,
  });

  const tags = !isLoading && data ? data.items : undefined;
  return { tags, isLoading, ...rest };
}
