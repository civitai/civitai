import type { ButtonProps } from '@mantine/core';
import { Divider, Drawer, Indicator, Popover, Stack, useMantineTheme } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { ArticleQueryInput } from '~/server/schema/article.schema';
import { FilterButton } from '~/components/Buttons/FilterButton';
import { IsClient } from '~/components/IsClient/IsClient';

export function ArticleFiltersDropdown({ query, onChange, ...buttonProps }: Props) {
  const theme = useMantineTheme();
  const mobile = useIsMobile();

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.articles,
    setFilters: state.setArticleFilters,
  }));

  const committedFilters = useMemo(() => query || filters, [query, filters]);

  const handleApply = useCallback(
    (next: typeof committedFilters) => {
      if (onChange) onChange(next);
      else setFilters(next);
    },
    [onChange, setFilters]
  );

  const handleClear = useCallback(() => {
    const reset = { period: MetricTimeframe.AllTime };
    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters({
      committed: committedFilters,
      onApply: handleApply,
      onClear: handleClear,
    });

  const filterLength =
    mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0;

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      processing
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
              fontSize: theme.fontSizes.sm,
              fontWeight: 700,
            },
          }}
        />
        <PeriodFilter
          type="articles"
          variant="chips"
          value={mergedFilters.period ?? MetricTimeframe.AllTime}
          onChange={(period) => patchPending({ period })}
        />
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
      <IsClient>
        {target}
        <Drawer
          opened={opened}
          onClose={close}
          size="90%"
          position="bottom"
          closeButtonProps={{
            style: {
              height: 32,
              width: 32,
              '& > svg': {
                width: 24,
                height: 24,
              },
            },
          }}
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
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{dropdownBody}</div>
          {dropdownFooter}
        </Drawer>
      </IsClient>
    );

  return (
    <IsClient>
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
    </IsClient>
  );
}

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<ArticleQueryInput>;
  onChange?: (params: Partial<ArticleQueryInput>) => void;
};
