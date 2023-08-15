// TODO.search: confirm this is going to be used
import {
  Chip,
  Group,
  HoverCard,
  PopoverDropdownProps,
  Stack,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { FilterIcon, FilterIdentifier } from '~/components/QuickSearch/util';
import { titleCase } from '~/utils/string-helpers';

const filterOptions: FilterIdentifier[] = ['models', 'users', 'tags', 'articles'];
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

type Props = PopoverDropdownProps;

export function AutocompleteDropdown({ children, ...props }: Props) {
  const { classes } = useStyles();
  console.log(props);

  return (
    <div {...props}>
      <Stack spacing={0}>
        <Chip.Group spacing="xs" py="sm" px="md" defaultValue="models" noWrap>
          {filterOptions.map((option) => {
            return (
              <Chip key={option} classNames={classes} value={option} radius="sm">
                <Group spacing={4} noWrap>
                  {titleCase(option)}
                  {option !== 'all' && (
                    <HoverCard withinPortal withArrow width={300} shadow="sm" openDelay={500}>
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
        {children}
      </Stack>
    </div>
  );
}
