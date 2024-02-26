import { Group, GroupProps } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { SortFilter } from '../SortFilter';
import { useFeedFiltersStyles } from './FeedFilters.styles';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const { classes } = useFeedFiltersStyles();

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter
        type="articles"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <ArticleFiltersDropdown size="sm" w="100%" compact className={classes.subnavDropdown} />
    </Group>
  );
}
