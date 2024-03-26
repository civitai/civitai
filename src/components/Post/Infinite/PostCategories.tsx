import { TagTarget } from '@prisma/client';
import { usePostQueryParams } from '~/components/Post/post.utils';
import { TagScroller } from '~/components/Tags/TagScroller';
import { useCategoryTags } from '~/components/Tags/tag.utils';

export function PostCategories() {
  // const { data: items = [] } = trpc.post.getTags.useQuery({ limit: 100 });
  const { query, replace } = usePostQueryParams();
  const { data: items } = useCategoryTags({ entityType: TagTarget.Post });

  return <TagScroller data={items} value={query.tags} onChange={(tags) => replace({ tags })} />;
}
