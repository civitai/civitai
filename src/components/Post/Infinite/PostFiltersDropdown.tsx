import type { ButtonProps } from '@mantine/core';
import { Divider, Drawer, Indicator, Popover, Stack, Tooltip } from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { PostsQueryInput } from '~/server/schema/post.schema';
import { FilterButton } from '~/components/Buttons/FilterButton';

export function PostFiltersDropdown({
  query,
  onChange,
  style,
  showScheduled = true,
  ...buttonProps
}: Props) {
  const mobile = useIsMobile();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.posts,
    setFilters: state.setPostFilters,
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
    const reset = { period: MetricTimeframe.AllTime, scheduled: undefined };
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
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (showScheduled && mergedFilters.scheduled ? 1 : 0);

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton {...buttonProps} icon={IconFilter} onClick={toggle} active={opened}>
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdownBody = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Time period" className="text-sm font-bold" />
        <PeriodFilter
          type="posts"
          variant="chips"
          value={mergedFilters.period ?? MetricTimeframe.AllTime}
          onChange={(period) => patchPending({ period })}
        />
      </Stack>
      {showScheduled && currentUser && !isModerator && (
        <Stack gap="md">
          <Divider label="Modifiers" className="text-sm font-bold" />
          <div className="flex flex-wrap gap-2">
            <FilterChip
              checked={!!mergedFilters.scheduled}
              onChange={(checked) => patchPending({ scheduled: checked })}
            >
              <Tooltip label="Include your scheduled posts">
                <span>Scheduled</span>
              </Tooltip>
            </FilterChip>
          </div>
        </Stack>
      )}
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

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<PostsQueryInput>;
  onChange?: (params: Partial<PostsQueryInput>) => void;
  showScheduled?: boolean;
};
