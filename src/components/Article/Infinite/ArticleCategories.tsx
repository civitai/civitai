import { TagTarget } from '~/shared/utils/prisma/enums';
import { useRouter } from 'next/router';

import { TagScroller } from '~/components/Tags/TagScroller';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagSort } from '~/server/common/enums';
import { parseNumericStringArray } from '~/utils/query-string-helpers';
import { trpc } from '~/utils/trpc';

export function ArticleCategories() {
  const router = useRouter();
  const { data: items } = useCategoryTags({ entityType: TagTarget.Article });

  const tagIds = parseNumericStringArray(router.query.tags);
  const handleChange = (ids: number[]) => {
    const { pathname, query } = router;
    router.replace({ pathname, query: { ...query, tags: ids } }, undefined, {
      shallow: true,
      scroll: false,
    });
  };

  return <TagScroller data={items} value={tagIds} onChange={handleChange} />;

  // return null;
  // TODO Restore this when we have categories
  // const tags = useFiltersContext((state) => state.image.tags ?? []);
  // const setFilters = useFiltersContext((state) => state.setFilters);

  // return (
  //   <TagScroller data={items} value={tags} onChange={(tags) => setFilters({ image: { tags } })} />
  // );
}
