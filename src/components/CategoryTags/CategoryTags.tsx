import { useModelQueryParams } from '~/components/Model/model.utils';
import type { TagChipRowItem } from '~/components/Tags/TagChipRow';
import { TagChipRow } from '~/components/Tags/TagChipRow';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '~/shared/utils/prisma/enums';

// `selected` without `setSelected` would be silently discarded — the bar reads the URL
// and writes it, ignoring the prop. Pairing them in the type makes that uncompilable.
// The controlled branch admits an explicit `selected={undefined}` only because
// `exactOptionalPropertyTypes` is off; turning it on breaks the resource-select modal here.
type CategoryTagsProps = {
  filter?: (tag: string) => boolean;
  includeAll?: boolean;
} & (
  | { selected?: undefined; setSelected?: undefined }
  | { selected?: string; setSelected: (tag?: string) => void }
);

export function CategoryTags({
  selected,
  setSelected,
  filter,
  includeAll = true,
}: CategoryTagsProps) {
  const { set, tag: tagQuery } = useModelQueryParams();

  const { data: categories } = useCategoryTags({ entityType: TagTarget.Model });

  const handleSetTag = (tag: string | undefined) => set({ tag });

  // Controlled and uncontrolled are either/or, not a fallback chain: the generation
  // resource-select modal opens over /models, so `selected ?? tagQuery` would let the
  // page's `?tag=` light up a chip the modal has not actually filtered on.
  const controlled = !!setSelected;
  const _tag = controlled ? selected : tagQuery;
  const _setTag = setSelected ?? handleSetTag;

  // This bar identifies a category by NAME — `?tag=` carries the name, not the id — so the
  // row's id is the name here. Tag names are unique, so it is still a stable key.
  const items = categories
    .filter((x) => (filter ? filter(x.name) : true))
    .map((tag) => ({ id: tag.name, label: tag.name }));

  const handleSelect = (item: TagChipRowItem) => _setTag(_tag === item.id ? undefined : item.label);

  return (
    <TagChipRow
      items={items}
      activeId={_tag}
      onSelect={handleSelect}
      onClear={() => _setTag(undefined)}
      includeAll={includeAll}
      // Pre-filter, deliberately: a `filter` that empties the list still leaves the All
      // chip rendered, which is what this bar did before the row was shared.
      loading={!categories.length}
    />
  );
}
