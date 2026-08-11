import type { ChipProps } from '@mantine/core';
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
import { IconFilter } from '@tabler/icons-react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { getDisplayName } from '~/utils/string-helpers';
import React, { useCallback, useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import type { GetShopInput } from '~/server/schema/cosmetic-shop.schema';
import classes from './ShopFiltersDropdown.module.scss';

// `wishlisted` is deliberately not folded into `modifier`: the modifiers are a
// single-select group, and wishlisted has to be combinable with owned/notOwned.
export type ShopFilters = GetShopInput & {
  modifier?: 'owned' | 'notOwned';
  wishlisted?: boolean;
  limited?: boolean;
  acceptsBlueBuzz?: boolean;
};

type Filters = ShopFilters;

export function ShopFiltersDropdown({ filters, setFilters, availableTypes }: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const currentUser = useCurrentUser();

  const types = availableTypes ?? (Object.values(CosmeticType) as CosmeticType[]);

  // Owned and wishlisted both read the viewer's own collection, so neither can
  // do anything logged out.
  const canFilterByAccount = !!currentUser;
  const accountFiltersActive = !!filters.modifier || !!filters.wishlisted;

  // Logging out mid-browse leaves those filters set with no chip to unset them,
  // and they'd keep matching against an empty owned/wishlisted set — an empty
  // grid the viewer can't recover from.
  useEffect(() => {
    if (canFilterByAccount || !accountFiltersActive) return;
    setFilters((prev) => ({ ...prev, modifier: undefined, wishlisted: undefined }));
  }, [canFilterByAccount, accountFiltersActive, setFilters]);

  const [opened, setOpened] = useState(false);
  const filterLength =
    (filters.cosmeticTypes ? filters.cosmeticTypes.length : 0) +
    (canFilterByAccount && !!filters.modifier ? 1 : 0) +
    (canFilterByAccount && filters.wishlisted ? 1 : 0) +
    (filters.limited ? 1 : 0) +
    (filters.acceptsBlueBuzz ? 1 : 0);

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
      <FilterButton
        icon={IconFilter}
        active={opened}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
      >
        Filters
      </FilterButton>
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
            {types.map((type, index) => (
              <Chip key={index} value={type} {...chipProps}>
                <span>{getDisplayName(type)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      {canFilterByAccount && (
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
                Hide Owned
              </Chip>
            </Group>
          </Chip.Group>
        </Stack>
      )}
      <Stack gap="md">
        <Divider label="More Filters" className="text-sm font-bold" />
        <Group gap={8}>
          {canFilterByAccount && (
            <Chip
              checked={!!filters.wishlisted}
              onChange={(checked) => setFilters((prev) => ({ ...prev, wishlisted: checked }))}
              {...chipProps}
            >
              Wishlisted
            </Chip>
          )}
          <Chip
            checked={!!filters.limited}
            onChange={(checked) => setFilters((prev) => ({ ...prev, limited: checked }))}
            {...chipProps}
          >
            Limited
          </Chip>
          <Chip
            checked={!!filters.acceptsBlueBuzz}
            onChange={(checked) => setFilters((prev) => ({ ...prev, acceptsBlueBuzz: checked }))}
            {...chipProps}
          >
            Accepts Blue Buzz
          </Chip>
        </Group>
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
  // Restrict the cosmetic-type chips (e.g. Creator Shop shows only sellable types).
  availableTypes?: CosmeticType[];
};
