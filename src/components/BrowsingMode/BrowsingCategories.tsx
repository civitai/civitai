import { Chip, Group } from '@mantine/core';
import { useQueryHiddenPreferences, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { toggleableBrowsingCategories } from '~/shared/constants/browsingLevel.constants';

/**
 * Chips rather than a checkbox column: four stacked rows cost more height than the choice is worth,
 * and every one of them said "Hide …" down the left edge.
 */
export function BrowsingCategories() {
  const { data, isLoading } = useQueryHiddenPreferences();

  const toggleHiddenTagsMutation = useToggleHiddenPreferences();

  const toggle = (checked: boolean, tags: { id: number; name: string }[]) => {
    if (isLoading) return;
    toggleHiddenTagsMutation.mutate({ data: tags, kind: 'tag', hidden: checked });
  };

  return (
    <Group gap="xs">
      {toggleableBrowsingCategories.map((category) => {
        const checked = category.relatedTags.every((tag) =>
          data.hiddenTags.find((hidden) => hidden.id === tag.id)
        );

        return (
          <Chip
            key={category.title}
            size="sm"
            radius="sm"
            checked={checked}
            disabled={isLoading}
            onChange={(value) => toggle(value, category.relatedTags)}
          >
            {category.title}
          </Chip>
        );
      })}
    </Group>
  );
}
