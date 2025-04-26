// TODO.search: confirm this is going to be used
import {
  Chip,
  Group,
  HoverCard,
  PopoverDropdownProps,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { titleCase } from '~/utils/string-helpers';
import {
  IconAmpersand,
  IconAt,
  IconCurrencyDollar,
  IconHash,
  IconSearch,
  IconProps,
} from '@tabler/icons-react';
import classes from './AutocompleteDropdown.module.scss';

export type FilterIndex = 'models' | 'users' | 'tags' | 'articles';
export type FilterIdentifier = FilterIndex | 'all';

export function FilterIcon({ type, ...props }: IconProps & { type: FilterIdentifier }) {
  return {
    models: <IconCurrencyDollar {...props} />,
    users: <IconAt {...props} />,
    articles: <IconAmpersand {...props} />,
    tags: <IconHash {...props} />,
    all: <IconSearch {...props} />,
  }[type];
}

const filterOptions: FilterIdentifier[] = ['models', 'users', 'tags', 'articles'];

type Props = PopoverDropdownProps;

export function AutocompleteDropdown({ children, ...props }: Props) {
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

