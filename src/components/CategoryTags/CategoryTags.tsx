import { Button, useComputedColorScheme } from '@mantine/core';

import { useCategoryTags } from '~/components/Tags/tag.utils';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { TagTarget } from '~/shared/utils/prisma/enums';

export function CategoryTags({
  selected,
  setSelected,
  filter,
}: {
  selected?: string;
  setSelected: (tag?: string) => void;
  filter?: (tag: string) => boolean;
}) {
  const colorScheme = useComputedColorScheme('dark');

  const { data: categories } = useCategoryTags({ entityType: TagTarget.Model });

  if (!categories.length) return null;

  return (
    <TwScrollX className="flex gap-1">
      {categories
        .filter((x) => (filter ? filter(x.name) : true))
        .map((tag) => {
          const active = selected === tag.name;
          return (
            <Button
              key={tag.id}
              className="overflow-visible uppercase"
              variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
              color={active ? 'blue' : 'gray'}
              onClick={() => setSelected(!active ? tag.name : undefined)}
              size="compact-sm"
            >
              {tag.name}
            </Button>
          );
        })}
    </TwScrollX>
  );
}
