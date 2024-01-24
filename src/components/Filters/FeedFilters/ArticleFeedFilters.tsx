import { Group, GroupProps } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { ViewToggle } from '../ViewToggle';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter type="articles" variant="button" />
      <ArticleFiltersDropdown size="xs" compact />
      <ViewToggle
        type="articles"
        color="gray"
        radius="xl"
        size="sm"
        iconSize={14}
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
      />
    </Group>
  );
}
