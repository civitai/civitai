import { useArticleQueryParams } from '~/components/Article/article.utils';
import { ActiveTagFilter } from '~/components/Tags/ActiveTagFilter';
import type { TagChipRowItem } from '~/components/Tags/TagChipRow';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '~/shared/utils/prisma/enums';

/**
 * Category row for `/articles`, writing `?tags=<id>`.
 *
 * This bar is NOT the `/images` and `/videos` one. Those carry a hand-curated chip set
 * (`feed-tag-bar.constants`) that exists to be measured and can be switched off on the
 * `feedTagBar` flag; this one is the article CATEGORY taxonomy — the `article category`
 * system tag's children, moderator-curated, the same set the article editor makes an
 * author pick from. It is navigation over a fixed set, so it carries no flag and no
 * click instrumentation: `Feed_TagBar_Click` is the series the image bar's fate is being
 * decided on (868kv1b9m), and mixing a differently-motivated surface into it would move
 * a number that decides something else.
 *
 * Ids, not names: `?tags=` on this feed carries tag ids (`numericStringArray`), unlike
 * `/models`' `?tag=`, which carries a name. `CategoryTags` uses the name as its row id
 * for that reason; here the row id is the real tag id.
 *
 * Single-select, unlike the ctrl-click stacking the deleted `TagScroller` had. Not for
 * the reason the image bar gives: `getArticles` filters `?tags=` with `toa."tagId" IN
 * (...)`, so several ids there are a UNION and would widen this feed rather than empty
 * it. It is that an article carries exactly one category — `ArticleUpsertForm` makes the
 * author pick one from this same list — so the union of two of them is not a thing a
 * reader asked for, and no article is in both.
 *
 * The `All` chip is what widens a `?tags=` deep link back out. `ActiveTagFilter` stands
 * in wherever that chip is not on the page — which here is the settled-and-empty chip
 * list, the state a failed category fetch leaves the bar in permanently. Neither may
 * take the only escape hatch from a `?tags=` deep link with it (868kuq3jk).
 */
export function ArticleCategories() {
  // The same hook the feed itself filters through (`ArticlesPage` passes this `query`
  // straight to `ArticlesInfinite`). Reading `router.query` directly here instead would
  // give the chips and the feed two different parsers for one param, and the symptom of
  // them drifting is a chip that looks unselected while the feed is filtered.
  const { query, replace } = useArticleQueryParams();
  const tagIds = query.tags ?? [];

  const { data: categories, isLoading } = useCategoryTags({ entityType: TagTarget.Article });

  // A chip is active only when it is the sole filter — anything else came from a deep
  // link this bar cannot represent, and lighting one chip of several would misdescribe it.
  //
  // But `undefined` is what fills the All chip, and All means UNFILTERED. A `?tags=` the
  // bar cannot draw — several ids, or one that is not a category — would otherwise light
  // All over a narrowed feed. So those states get an id no chip can hold: every chip
  // stays grey, which is the truth, and All still clears the param.
  const unrepresentable = 'unrepresentable-tag-filter';
  const activeId =
    tagIds.length === 0
      ? undefined
      : tagIds.length === 1 && categories.some((tag) => tag.id === tagIds[0])
      ? tagIds[0]
      : unrepresentable;

  const handleSelect = (item: TagChipRowItem) => {
    const id = item.id as number;
    replace({ tags: activeId === id ? [] : [id] });
  };

  const handleClear = () => replace({ tags: [] });

  // `isLoading` already folds in the hidden-preferences fetch (`useCategoryTags`), so a
  // category the viewer has personally hidden cannot flash as a chip before that
  // resolves. Holding on `!categories.length` as well covers the gap where the tag query
  // has settled and preferences have not.
  const chipsHeld = isLoading || !categories.length;

  // SETTLED and still empty — a failed or empty category fetch, which is permanent, not
  // the in-flight state. `chipsHeld` alone would put the clear control on screen for
  // every viewer's first paint and take it away again a moment later.
  const chipsGone = !isLoading && !categories.length;

  return (
    <TagChipRow
      items={categories.map((tag) => ({ id: tag.id, label: tag.name }))}
      activeId={activeId}
      onSelect={handleSelect}
      onClear={handleClear}
      loading={chipsHeld}
      // Inside the reservation, so standing in for the chips costs no extra height.
      placeholder={chipsGone ? <ActiveTagFilter tagIds={tagIds} /> : null}
    />
  );
}
