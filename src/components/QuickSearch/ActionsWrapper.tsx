import { Chip, Group, Anchor, Badge, Stack, Text, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';
import { useSearchStore } from '~/components/QuickSearch/search.store';
import { FilterIndex } from '~/components/QuickSearch/util';
import { titleCase } from '~/utils/string-helpers';

const filterOptions: FilterIndex[] = ['models', 'users', 'tags', 'articles'];

const useStyles = createStyles((theme, _, getRef) => {
  const ref = getRef('iconWrapper');

  return {
    label: {
      '&[data-checked]': {
        '&, &:hover': {
          backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
          color: theme.white,
        },

        [`& .${ref}`]: {
          color: theme.white,
        },
      },
    },

    iconWrapper: { ref },
  };
});

export function ActionsWrapper({ children }: Props) {
  const { classes } = useStyles();
  const { setQuery, quickSearchFilter, setQuickSearchFilter } = useSearchStore();

  const handleFilterClick = (filter: FilterIndex | 'all') => {
    setQuickSearchFilter(filter);

    if (filter === 'all') {
      setQuery((query) => query.replace(/^[&$@#]/, ''));
    } else if (filter === 'models') {
      setQuery((query) => (query.startsWith('$') ? query : `$${query.replace(/^[&$@#]/, '')}`));
    } else if (filter === 'users') {
      setQuery((query) => (query.startsWith('@') ? query : `@${query.replace(/^[&$@#]/, '')}`));
    } else if (filter === 'tags') {
      setQuery((query) => (query.startsWith('#') ? query : `#${query.replace(/^[&$@#]/, '')}`));
    } else if (filter === 'articles') {
      setQuery((query) => (query.startsWith('&') ? query : `&${query.replace(/^[&$@#]/, '')}`));
    }
  };

  return (
    <>
      <Stack
        spacing={8}
        px={15}
        py="xs"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
      >
        <Text size="xs" color="dimmed" inline>
          Filter Results
        </Text>
        <Chip.Group value={quickSearchFilter} spacing="xs" onChange={handleFilterClick}>
          <Chip classNames={classes} value="all" radius="sm">
            All
          </Chip>
          {filterOptions.map((option) => (
            <Chip key={option} classNames={classes} value={option} radius="sm">
              {titleCase(option)}
            </Chip>
          ))}
        </Chip.Group>
        <Group spacing="xs">
          <Badge color="yellow" variant="light" size="xs">
            Beta
          </Badge>
          <Text size="xs" color="dimmed" inline>
            Expect frequent changes.
          </Text>
          <Anchor
            size="xs"
            component={NextLink}
            onClick={() => closeSpotlight()}
            href="/user/account#settings"
            ml="auto"
            inline
          >
            Opt-out
          </Anchor>
        </Group>
      </Stack>
      {children}
    </>
  );
}

type Props = {
  children: React.ReactNode;
  onFilterClick?: React.Dispatch<React.SetStateAction<string>>;
};
