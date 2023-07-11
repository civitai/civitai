import React from 'react';
import {
  Chip,
  Group,
  Anchor,
  Badge,
  Stack,
  Text,
  createStyles,
  HoverCard,
  Accordion,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';
import { useSearchStore } from '~/components/QuickSearch/search.store';
import {
  FilterIdentifier,
  filterIcons,
  getAvailableFiltersByIndexName,
  FilterIndex,
} from '~/components/QuickSearch/util';
import { titleCase } from '~/utils/string-helpers';
import { IconPlus } from '@tabler/icons-react';

const filterOptions: FilterIdentifier[] = ['all', 'models', 'users', 'tags', 'articles'];

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

  const availableFilters = getAvailableFiltersByIndexName(quickSearchFilter as FilterIndex).filter(
    (item) => !item.filterId && !!item.label
  );

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
          {filterOptions.map((option) => {
            const Wrapper =
              option === quickSearchFilter && availableFilters.length > 0
                ? ({ children }: { children: React.ReactNode }) => (
                    <HoverCard width={200} withArrow>
                      <HoverCard.Target>{children}</HoverCard.Target>
                      <HoverCard.Dropdown></HoverCard.Dropdown>
                    </HoverCard>
                  )
                : ({ children }: { children: React.ReactNode }) => <>{children}</>;

            return (
              <Wrapper>
                <Chip key={option} classNames={classes} value={option} radius="sm">
                  <Group spacing={4} noWrap>
                    {option !== 'all' ? filterIcons[option] : null}
                    {titleCase(option)}
                  </Group>
                </Chip>
              </Wrapper>
            );
          })}
        </Chip.Group>
      </Stack>

      {quickSearchFilter !== 'all' && availableFilters.length > 0 && (
        <Accordion
          chevron={<IconPlus size="1rem" />}
          styles={{
            chevron: {
              '&[data-rotate]': {
                transform: 'rotate(45deg)',
              },
            },
          }}
        >
          <Accordion.Item value="filters">
            <Accordion.Control>Available filters:</Accordion.Control>
            <Accordion.Panel>
              <Stack spacing={4}>
                <Text size="xs">
                  You add these values to your query to improve the accuracy of your search
                </Text>
                {availableFilters.map((filter) => (
                  <Stack key={filter.label} spacing={1}>
                    <Text size="sm" color="gold">
                      {filter.label}
                    </Text>
                    <Text size="sm" color="dimmed">
                      {filter.description}
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}

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
