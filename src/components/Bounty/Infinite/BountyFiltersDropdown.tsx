import type { ButtonProps } from '@mantine/core';
import { Popover, Group, Indicator, Stack, Divider, Chip, Drawer } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { BountyType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { useCallback } from 'react';
import { BountyStatus } from '~/server/common/enums';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import { activeBaseModels } from '~/shared/constants/basemodel.constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PeriodFilter } from '~/components/Filters';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { FilterChip } from '~/components/Filters/FilterChip';

const supportsBaseModel = [
  BountyType.ModelCreation,
  BountyType.LoraCreation,
  BountyType.EmbedCreation,
] as const;

const checkSupportsBaseModel = (types: BountyType[]) => {
  return types.some((type) =>
    supportsBaseModel.includes(type as (typeof supportsBaseModel)[number])
  );
};

export function BountyFiltersDropdown({ ...buttonProps }: Props) {
  const mobile = useIsMobile();

  const { filters: committedFilters, setFilters } = useFiltersContext((state) => ({
    filters: state.bounties,
    setFilters: state.setBountyFilters,
  }));

  const handleClear = useCallback(
    () =>
      setFilters({
        types: undefined,
        status: undefined,
        baseModels: undefined,
        period: MetricTimeframe.AllTime,
      }),
    [setFilters]
  );

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: setFilters,
      onClear: handleClear,
    });

  const filterLength =
    (mergedFilters.types?.length ?? 0) +
    (mergedFilters.baseModels?.length ?? 0) +
    (!!mergedFilters.status ? 1 : 0) +
    (mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0);

  const showBaseModelFilter = checkSupportsBaseModel(mergedFilters.types ?? []);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton icon={IconFilter} onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdownBody = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider
          label="Time period"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <PeriodFilter
          type="bounties"
          variant="chips"
          value={mergedFilters.period ?? MetricTimeframe.AllTime}
          onChange={(period) => patchPending({ period })}
        />
      </Stack>
      <Stack gap="md">
        <Divider
          label="Bounty type"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <Chip.Group
          value={mergedFilters.types ?? []}
          onChange={(v: string[]) => {
            const types = v as BountyType[];
            const clearBaseModelFilter = !checkSupportsBaseModel(types);
            patchPending({
              types,
              baseModels: clearBaseModelFilter ? undefined : mergedFilters.baseModels,
            });
          }}
          multiple
        >
          <Group gap={8}>
            {Object.values(BountyType).map((type, index) => (
              <FilterChip key={index} value={type}>
                <span>{getDisplayName(type)}</span>
              </FilterChip>
            ))}
          </Group>
        </Chip.Group>
      </Stack>
      {showBaseModelFilter && (
        <Stack gap="md">
          <Divider
            label="Base model"
            styles={{
              label: {
                weight: 'bold',
                size: 'var(--mantine-font-size-sm)',
              },
            }}
          />
          <Chip.Group
            value={mergedFilters.baseModels ?? []}
            onChange={(baseModels: string[]) =>
              patchPending({ baseModels: baseModels as BaseModel[] })
            }
            multiple
          >
            <Group gap={8}>
              {activeBaseModels.map((baseModel, index) => (
                <FilterChip key={index} value={baseModel}>
                  <span>{baseModel}</span>
                </FilterChip>
              ))}
            </Group>
          </Chip.Group>
        </Stack>
      )}
      <Stack gap="md">
        <Divider
          label="Bounty status"
          styles={{
            label: {
              weight: 'bold',
              size: 'var(--mantine-font-size-sm)',
            },
          }}
        />
        <Group gap={8}>
          {Object.values(BountyStatus).map((status, index) => (
            <FilterChip
              key={index}
              checked={mergedFilters.status === status}
              onChange={(checked) => patchPending({ status: checked ? status : undefined })}
            >
              <span>{getDisplayName(status)}</span>
            </FilterChip>
          ))}
        </Group>
      </Stack>
    </Stack>
  );

  const dropdownFooter = (
    <StagedFiltersFooter
      isDirty={isDirty}
      onApply={apply}
      onReset={reset}
      filterLength={filterLength}
      onClear={clearAndClose}
    />
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={close}
          size="90%"
          position="bottom"
          styles={{
            content: {
              maxHeight: 'calc(100dvh - var(--header-height))',
              display: 'flex',
              flexDirection: 'column',
            },
            body: {
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              flex: 1,
              minHeight: 0,
            },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{dropdownBody}</div>
          {dropdownFooter}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      opened={opened}
      onClose={close}
      middlewares={{ flip: true, shift: true }}
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        {dropdownBody}
        {dropdownFooter}
      </Popover.Dropdown>
    </Popover>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'>;
