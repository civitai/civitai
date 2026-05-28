import type { ButtonProps } from '@mantine/core';
import {
  Button,
  Divider,
  Drawer,
  Indicator,
  Popover,
  Stack,
  Tooltip,
  useComputedColorScheme,
} from '@mantine/core';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { IconFilter } from '@tabler/icons-react';
import { useCallback, useState } from 'react';
import { PeriodFilter } from '~/components/Filters';
import { FilterChip } from '~/components/Filters/FilterChip';
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
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;

  const [opened, setOpened] = useState(false);

  const { filters, setFilters } = useFiltersContext((state) => ({
    filters: state.posts,
    setFilters: state.setPostFilters,
  }));

  const mergedFilters = query || filters;

  const filterLength =
    (mergedFilters.period && mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (showScheduled && mergedFilters.scheduled ? 1 : 0);

  const clearFilters = useCallback(() => {
    const reset = {
      period: MetricTimeframe.AllTime,
      scheduled: undefined,
    };

    if (onChange) onChange(reset);
    else setFilters(reset);
  }, [onChange, setFilters]);

  const handleChange: Props['onChange'] = (value) => {
    onChange ? onChange(value) : setFilters(value);
  };

  const target = (
    <Indicator
      offset={4}
      label={filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      inline
    >
      <FilterButton
        {...buttonProps}
        icon={IconFilter}
        onClick={() => setOpened((o) => !o)}
        active={opened}
      >
        Filters
      </FilterButton>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg">
      <Stack gap="md">
        <Divider label="Time period" className="text-sm font-bold" />
        {query?.period && onChange ? (
          <PeriodFilter
            type="posts"
            variant="chips"
            value={query.period}
            onChange={(period) => onChange({ period })}
          />
        ) : (
          <PeriodFilter type="posts" variant="chips" />
        )}
      </Stack>
      {showScheduled && currentUser && !isModerator && (
        <Stack gap="md">
          <Divider label="Modifiers" className="text-sm font-bold" />
          <div className="flex flex-wrap gap-2">
            <FilterChip
              checked={!!mergedFilters.scheduled}
              onChange={(checked) => handleChange({ scheduled: checked })}
            >
              <Tooltip label="Include your scheduled posts">
                <span>Scheduled</span>
              </Tooltip>
            </FilterChip>
          </div>
        </Stack>
      )}
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

type Props = Omit<ButtonProps, 'onClick' | 'children' | 'rightIcon'> & {
  query?: Partial<PostsQueryInput>;
  onChange?: (params: Partial<PostsQueryInput>) => void;
  showScheduled?: boolean;
};
