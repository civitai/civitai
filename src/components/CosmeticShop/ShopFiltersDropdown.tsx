import type { ChipProps, ButtonProps } from '@mantine/core';
import {
  Popover,
  Group,
  Indicator,
  Stack,
  Divider,
  Chip,
  Button,
  Drawer,
  useComputedColorScheme,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { getDisplayName } from '~/utils/string-helpers';
import React, { useCallback, useState } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import classes from './ShopFiltersDropdown.module.scss';
import clsx from 'clsx';

type Filters = GetShopInput & { modifier?: 'owned' | 'notOwned' };

export function ShopFiltersDropdown({ filters, setFilters, ...buttonProps }: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);
  const filterLength =
    (filters.cosmeticTypes ? filters.cosmeticTypes.length : 0) + (!!filters.modifier ? 1 : 0);

  const clearFilters = useCallback(() => setFilters({}), [setFilters]);

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
  };

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        {...buttonProps}
        rightSection={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        <Group gap={4} wrap="nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider label="Filter by Cosmetic Types" className="text-sm font-bold" />
        <Chip.Group
          value={filters.cosmeticTypes ?? []}
          onChange={(cosmeticTypes) => {
            setFilters((prev) => ({ ...prev, cosmeticTypes: cosmeticTypes as CosmeticType[] }));
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(CosmeticType).map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                <span>{getDisplayName(type)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      <Stack gap="md">
        <Divider label="Modifiers" className="text-sm font-bold" />
        <Chip.Group
          value={filters.modifier}
          onChange={(modifier) =>
            setFilters((prev) => ({ ...prev, modifier: modifier as Filters['modifier'] }))
          }
        >
          <Group gap={8}>
            <Chip value="owned" {...chipProps}>
              Owned
            </Chip>
            <Chip value="notOwned" {...chipProps}>
              Not Owned
            </Chip>
          </Group>
        </Chip.Group>
      </Stack>
      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          styles={{
            content: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 16, paddingTop: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p="md" w="100%">
        {dropdown}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = {
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  filters: Filters;
} & Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;
