import {
  Accordion,
  Anchor,
  Badge,
  Chip,
  Group,
  ScrollArea,
  Stack,
  Text,
  createStyles,
  ThemeIcon,
  HoverCard,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { closeSpotlight } from '@mantine/spotlight';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef } from 'react';
import { useSearchStore } from '~/components/QuickSearch/search.store';
import {
  FilterIdentifier,
  FilterIndex,
  getAvailableFiltersByIndexName,
  FilterIcon,
} from '~/components/QuickSearch/util';
import { titleCase } from '~/utils/string-helpers';

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

    filterIcon:
      theme.colorScheme === 'dark'
        ? {
            background: theme.colors.gray[8],
            borderColor: theme.colors.gray[7],
            color: theme.colors.gray[5],
          }
        : {
            background: theme.colors.gray[3],
            borderColor: theme.colors.gray[4],
            color: theme.colors.gray[6],
          },
  };
});
const useAccordionStyles = createStyles((theme) => {
  return {
    item: {
      paddingLeft: 15,
      paddingRight: 15,
      paddingBottom: theme.spacing.xs,
    },
    panel: {
      [theme.fn.smallerThan('md')]: {
        position: 'absolute',
        left: 0,
        background: theme.colors.gray[theme.fn.primaryShade()],
        zIndex: 10,
        width: '100%',
      },
    },
    control: {
      padding: 4,
      '&:hover': {
        backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[1],
      },
    },
    chevron: {
      '&[data-rotate]': {
        transform: 'rotate(45deg)',
      },
    },
  };
});

const ActionsWrapper = forwardRef<HTMLDivElement, Props>(({ children }, ref) => {
  const { classes } = useStyles();
  const { classes: accordionClasses } = useAccordionStyles();
  const quickSearchFilter = useSearchStore((state) => state.quickSearchFilter);
  const setQuickSearchFilter = useSearchStore((state) => state.setQuickSearchFilter);

  const availableFilters = getAvailableFiltersByIndexName(quickSearchFilter as FilterIndex).filter(
    (item) => !item.filterId && !!item.label
  );

  return (
    <>
      <div ref={ref}>
        <Stack
          spacing={4}
          py="xs"
          px={15}
          sx={(theme) => ({
            borderTop: `1px solid ${
              theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
            }`,
          })}
        >
          <Text size="xs" color="dimmed" inline>
            Filter Results
          </Text>
          <ScrollArea type="never" viewportProps={{ style: { overflowY: 'hidden' } }}>
            <Chip.Group
              value={quickSearchFilter}
              spacing="xs"
              onChange={setQuickSearchFilter}
              noWrap
            >
              {filterOptions.map((option) => {
                return (
                  <Chip key={option} classNames={classes} value={option} radius="sm">
                    <Group spacing={4} noWrap>
                      {titleCase(option)}
                      {option !== 'all' && (
                        <HoverCard
                          withinPortal
                          withArrow
                          width={300}
                          zIndex={10000}
                          shadow="xl"
                          openDelay={500}
                        >
                          <HoverCard.Target>
                            <ThemeIcon
                              className={classes.filterIcon}
                              size="xs"
                              radius="xs"
                              variant="default"
                            >
                              <FilterIcon type={option} size={12} strokeWidth={2.5} />
                            </ThemeIcon>
                          </HoverCard.Target>
                          <HoverCard.Dropdown>
                            <Text size="sm" weight={500}>
                              Pro-tip: Quick switching!
                            </Text>
                            <Text size="xs" lh={1.2}>
                              Start your search with this character to jump to searching these items
                            </Text>
                          </HoverCard.Dropdown>
                        </HoverCard>
                      )}
                    </Group>
                  </Chip>
                );
              })}
            </Chip.Group>
          </ScrollArea>
        </Stack>
        {quickSearchFilter !== 'all' && availableFilters.length > 0 && (
          <Accordion
            classNames={accordionClasses}
            chevron={<IconPlus size="1rem" />}
            variant="filled"
          >
            <Accordion.Item value="filters">
              <Accordion.Control>
                <Text size="sm">Available filters</Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Stack spacing="xs">
                  <Text size="xs">
                    You can further refine your search by adding these values to your query.
                  </Text>
                  {availableFilters.map((filter) => (
                    <Stack key={filter.label} spacing={1}>
                      <Text size="sm" color="gold" lh={1.2}>
                        {filter.label}
                      </Text>
                      <Text size="xs" color="dimmed" lh={1.2}>
                        {filter.description}
                      </Text>
                    </Stack>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        )}
      </div>
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
});

ActionsWrapper.displayName = 'ActionsWrapper';

type Props = { children: React.ReactNode };

export { ActionsWrapper };
