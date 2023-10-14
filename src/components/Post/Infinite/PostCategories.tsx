import { usePostQueryParams } from '~/components/Post/post.utils';
import { TagScroller } from '~/components/Tags/TagScroller';
import { trpc } from '~/utils/trpc';

export function PostCategories() {
  const { data: items = [] } = trpc.post.getTags.useQuery({ limit: 100 });
  const { query, replace } = usePostQueryParams();

  return <TagScroller data={items} value={query.tags} onChange={(tags) => replace({ tags })} />;
}
