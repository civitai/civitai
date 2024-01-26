import { Group, GroupProps } from '@mantine/core';
import { ArticleFiltersDropdown } from '~/components/Article/Infinite/ArticleFiltersDropdown';
import { env } from '~/env/client.mjs';
import { SortFilter } from '../SortFilter';
import { ViewToggle } from '../ViewToggle';
import { useFeedFiltersStyles } from './FeedFilters.styles';
import { useArticleQueryParams } from '~/components/Article/article.utils';

export function ArticleFeedFilters({ ...groupProps }: GroupProps) {
  const { classes, theme } = useFeedFiltersStyles();
  const {
    query: { favorites },
  } = useArticleQueryParams();
  const canToggleView = env.NEXT_PUBLIC_UI_CATEGORY_VIEWS && !favorites;

  return (
    <Group className={classes.filtersWrapper} spacing={8} noWrap {...groupProps}>
      <SortFilter
        type="articles"
        variant="button"
        buttonProps={{
          className: classes.subnavDropdown,
        }}
      />
      <ArticleFiltersDropdown size="sm" compact className={classes.subnavDropdown} />
      {canToggleView && (
        <ViewToggle
          type="articles"
          color="gray"
          radius="xl"
          size="sm"
          iconSize={16}
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        />
      )}
    </Group>
  );
}
