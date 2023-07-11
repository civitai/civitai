import { Chip, Group, Anchor, Badge, Stack, Text, createStyles } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';
import { useSearchStore } from '~/components/QuickSearch/search.store';
import { FilterIdentitier, filterIcons } from '~/components/QuickSearch/util';
import { titleCase } from '~/utils/string-helpers';

const filterOptions: FilterIdentitier[] = ['all', 'models', 'users', 'tags', 'articles'];

const useStyles = createStyles((theme, _, getRef) => {
  const ref = getRef('iconWrapper');

  return {
    label: {
      padding: `0 ${theme.spacing.xs}px`,

      '&[data-checked]': {
        '&, &:hover': {
          backgroundColor: theme.colors.blue[theme.fn.primaryShade()],
          color: theme.white,
        },

        [`& .${ref}`]: {
          display: 'none',
        },
      },
    },

    iconWrapper: { ref },
  };
});

export function ActionsWrapper({ children }: Props) {
  const { classes } = useStyles();
  const quickSearchFilter = useSearchStore((state) => state.quickSearchFilter);
  const setQuickSearchFilter = useSearchStore((state) => state.setQuickSearchFilter);

  return (
    <>
      <Stack
        px={15}
        py="xs"
        spacing={4}
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
      >
        <Text size="xs" color="dimmed" inline>
          Filter Results
        </Text>
        <Chip.Group value={quickSearchFilter} spacing="xs" onChange={setQuickSearchFilter}>
          {filterOptions.map((option) => (
            <Chip key={option} classNames={classes} value={option} radius="sm">
              <Group spacing={4} noWrap>
                {option !== 'all' ? filterIcons[option] : null}
                {titleCase(option)}
              </Group>
            </Chip>
          ))}
        </Chip.Group>
      </Stack>
      {children}
      <Group
        spacing="xs"
        px={15}
        py="xs"
        sx={(theme) => ({
          borderTop: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
          }`,
        })}
      >
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
    </>
  );
}

type Props = { children: React.ReactNode };
