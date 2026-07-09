import { useRouter } from 'next/router';
import { TagScroller } from '~/components/Tags/TagScroller';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { parseNumericStringArray } from '~/utils/query-string-helpers';

/**
 * Sub-nav category chip row for the /3d-models feed. Mirrors
 * `ArticleCategories` / `PostCategories` / `ImageCategories` — surfaces the
 * mod-curated category tags (tags whose `target` includes Model3D AND that
 * are linked to the `'model3d category'` system tag) instead of an
 * arbitrary "most popular" tag list. The selected category id(s) ride
 * through `?tags=` so deep links + back/forward retain filter context.
 *
 * The set is intentionally small (mod-curated) and alphabetised by
 * `useCategoryTags` — Model3D has no `TagMetric.modelCount` equivalent to
 * sort by usage, and a category list shouldn't churn anyway.
 */
export function Model3DCategories() {
  const router = useRouter();
  const { data: items } = useCategoryTags({ entityType: TagTarget.Model3D });

  // The page reads/writes a `tagId` (single) query param to drive the feed
  // tRPC query. The TagScroller emits a number[] — coalesce to the
  // single-value shape the feed expects and write back through the URL.
  const tagIds = parseNumericStringArray(router.query.tags);
  const handleChange = (ids: number[]) => {
    const { pathname, query } = router;
    router.replace({ pathname, query: { ...query, tags: ids } }, undefined, {
      shallow: true,
      scroll: false,
    });
  };

  return <TagScroller data={items} value={tagIds} onChange={handleChange} />;
}
