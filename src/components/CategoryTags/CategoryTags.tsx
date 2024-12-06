import { Button, useMantineTheme } from '@mantine/core';

import { useModelQueryParams } from '~/components/Model/model.utils';
import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TagTarget } from '~/shared/utils/prisma/enums';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { IconClock } from '@tabler/icons-react';
import { useFiltersContext } from '~/providers/FiltersProvider';

export function CategoryTags({
  selected,
  setSelected,
  filter,
}: {
  selected?: string;
  setSelected?: (tag?: string) => void;
  filter?: (tag: string) => boolean;
}) {
  const theme = useMantineTheme();
  const { set, tag: tagQuery } = useModelQueryParams();

  const { data: categories } = useCategoryTags({ entityType: TagTarget.Model });

  if (!categories.length) return null;

  const handleSetTag = (tag: string | undefined) => set({ tag });

  const _tag = selected ?? tagQuery;
  const _setTag = setSelected ?? handleSetTag;

  return (
    <TwScrollX className="flex gap-1">
      <EarlyAccessBadge />
      <Button
        className="uppercase"
        variant={!_tag ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
        color={!_tag ? 'blue' : 'gray'}
        onClick={() => _setTag(undefined)}
        compact
      >
        All
      </Button>
      {categories
        .filter((x) => (filter ? filter(x.name) : true))
        .map((tag) => {
          const active = _tag === tag.name;
          return (
            <Button
              key={tag.id}
              className="uppercase"
              variant={active ? 'filled' : theme.colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={() => _setTag(!active ? tag.name : undefined)}
              compact
            >
              {tag.name}
            </Button>
          );
        })}
    </TwScrollX>
  );
}

function EarlyAccessBadge() {
  const { setFilters, earlyAccess } = useFiltersContext((state) => ({
    setFilters: state.setModelFilters,
    earlyAccess: state.models.earlyAccess,
  }));

  return (
    <Button
      variant={earlyAccess ? 'filled' : 'outline'}
      color="success.5"
      onClick={() => setFilters({ earlyAccess: !earlyAccess })}
      compact
      leftIcon={<IconClock size={16} />}
    >
      Early Access
    </Button>
  );
}
