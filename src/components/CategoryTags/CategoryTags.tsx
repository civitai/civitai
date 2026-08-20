import { Button, useComputedColorScheme } from '@mantine/core';

import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { TagTarget } from '~/shared/utils/prisma/enums';

export function CategoryTags({
  selected,
  setSelected,
  filter,
  includeAll = true,
}: {
  selected?: string;
  setSelected?: (tag?: string) => void;
  filter?: (tag: string) => boolean;
  includeAll?: boolean;
}) {
  const colorScheme = useComputedColorScheme('dark');
  const { set, tag: tagQuery } = useModelQueryParams();

  const { data: categories } = useCategoryTags({ entityType: TagTarget.Model });

  // Reserve the row height while the client-side `useCategoryTags` query and the hidden
  // preferences resolve. Returning null lets the 26px chip row pop in and shove the feed
  // down — the shift `docs/cls-remediation-plan.md` measured at 0.65 on /images. That fix
  // landed in TagScroller, which these surfaces never used.
  if (!categories.length) return <div className="min-h-[26px]" />;

  const handleSetTag = (tag: string | undefined) => set({ tag });

  // Controlled and uncontrolled are either/or, not a fallback chain: the generation
  // resource-select modal opens over /models, so `selected ?? tagQuery` would let the
  // page's `?tag=` light up a chip the modal has not actually filtered on.
  const controlled = !!setSelected;
  const _tag = controlled ? selected : tagQuery;
  const _setTag = setSelected ?? handleSetTag;

  return (
    <TwScrollX className="flex min-h-[26px] gap-1">
      {includeAll && (
        <Button
          className="overflow-visible uppercase"
          variant={!_tag ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
          color={!_tag ? 'blue' : 'gray'}
          onClick={() => _setTag(undefined)}
          size="compact-sm"
        >
          All
        </Button>
      )}
      {categories
        .filter((x) => (filter ? filter(x.name) : true))
        .map((tag) => {
          const active = _tag === tag.name;
          return (
            <Button
              key={tag.id}
              className="overflow-visible uppercase"
              variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={() => _setTag(!active ? tag.name : undefined)}
              size="compact-sm"
            >
              {tag.name}
            </Button>
          );
        })}
    </TwScrollX>
  );
}
