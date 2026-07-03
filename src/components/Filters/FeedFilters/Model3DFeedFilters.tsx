import type { GroupProps } from '@mantine/core';
import {
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { FilterChip } from '~/components/Filters/FilterChip';
import { StagedFiltersFooter } from '~/components/Filters/StagedFiltersFooter';
import { useStagedFilters } from '~/components/Filters/useStagedFilters';
import { IsClient } from '~/components/IsClient/IsClient';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Model3DSort } from '~/server/schema/model3d.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { getDisplayName } from '~/utils/string-helpers';

/**
 * Sub-nav filter row for the /3d-models feed. Mirrors `ImageFeedFilters` /
 * `MediaFiltersDropdown`:
 *
 *   - Sort lives in a visible `SelectMenuV2` next to the Filters button.
 *   - Time period + modifiers (Rigged, Animated) live inside the Filters
 *     popover with a staged-apply footer (one user intent → one fetch).
 *
 * State is URL-backed; `useStagedFilters` keeps pending edits local until
 * Apply, mirroring the bulkhead-friendly pattern in
 * `MediaFiltersDropdown.tsx`.
 */
const SORT_VALUES = new Set<string>(Object.values(Model3DSort));
const PERIOD_VALUES = new Set<string>(Object.values(MetricTimeframe));

const sortOptions = Object.values(Model3DSort).map((v) => ({ label: v, value: v }));
const periodOptions = (Object.values(MetricTimeframe) as MetricTimeframe[]).map((p) => ({
  label: getDisplayName(p),
  value: p,
}));

type Model3DFilterState = {
  period: MetricTimeframe;
  animated: boolean;
  unrated: boolean;
};

export function Model3DFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const { query } = router;
  const isClient = useIsClient();
  const mobile = useIsMobile();
  const currentUser = useCurrentUser();
  const isModerator = !!currentUser?.isModerator;

  const sort = useMemo<Model3DSort>(() => {
    const raw = typeof query.sort === 'string' ? query.sort : undefined;
    return raw && SORT_VALUES.has(raw) ? (raw as Model3DSort) : Model3DSort.Newest;
  }, [query.sort]);

  const period = useMemo<MetricTimeframe>(() => {
    const raw = typeof query.period === 'string' ? query.period : undefined;
    return raw && PERIOD_VALUES.has(raw) ? (raw as MetricTimeframe) : MetricTimeframe.AllTime;
  }, [query.period]);

  const animated = query.animated === 'true';
  const unrated = isModerator && query.unrated === 'true';

  const setQuery = useCallback(
    (patch: Record<string, string | undefined>) => {
      router.replace(
        { pathname: router.pathname, query: removeEmpty({ ...query, ...patch }) },
        undefined,
        { shallow: true }
      );
    },
    [router, query]
  );

  // Committed = URL-backed state. Apply writes back to URL via setQuery.
  const committed: Model3DFilterState = useMemo(
    () => ({ period, animated, unrated }),
    [period, animated, unrated]
  );

  const handleApply = useCallback(
    (next: Model3DFilterState) => {
      setQuery({
        period: next.period === MetricTimeframe.AllTime ? undefined : next.period,
        animated: next.animated ? 'true' : undefined,
        unrated: next.unrated ? 'true' : undefined,
        // Clear any legacy `?rigged=` left in the URL from before the
        // rigging filter was removed (the Meshy API now binds rigging
        // to animation, so the filter is no longer meaningful).
        rigged: undefined,
      });
    },
    [setQuery]
  );

  const handleClear = useCallback(() => {
    setQuery({ period: undefined, animated: undefined, unrated: undefined, rigged: undefined });
  }, [setQuery]);

  const { opened, toggle, close, mergedFilters, isDirty, patchPending, apply, reset, clearAndClose } =
    useStagedFilters<Model3DFilterState>({
      committed,
      onApply: handleApply,
      onClear: handleClear,
    });

  const filterLength =
    (mergedFilters.period !== MetricTimeframe.AllTime ? 1 : 0) +
    (mergedFilters.animated ? 1 : 0) +
    (mergedFilters.unrated ? 1 : 0);

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
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
        <Divider label="Time period" className="text-sm font-bold" mb={4} />
        <IsClient>
          <Chip.Group
            value={mergedFilters.period}
            onChange={(value) =>
              patchPending({ period: (value as MetricTimeframe) ?? MetricTimeframe.AllTime })
            }
          >
            <Group gap={8}>
              {periodOptions.map((opt) => (
                <FilterChip key={opt.value} value={opt.value}>
                  <span>{opt.label}</span>
                </FilterChip>
              ))}
            </Group>
          </Chip.Group>
        </IsClient>
      </Stack>

      <Stack gap="md">
        <Divider label="Modifiers" className="text-sm font-bold" mb={4} />
        <div className="flex flex-wrap gap-2">
          <FilterChip
            checked={mergedFilters.animated}
            onChange={(checked) => patchPending({ animated: checked })}
          >
            <span>Animated</span>
          </FilterChip>
          {/* Mod-only: surface not-yet-rated models so they can be triaged. */}
          {isModerator && (
            <FilterChip
              checked={mergedFilters.unrated}
              onChange={(checked) => patchPending({ unrated: checked })}
            >
              <span>Unrated</span>
            </FilterChip>
          )}
        </div>
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

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      <SelectMenuV2
        label={sort}
        value={sort}
        options={sortOptions}
        onClick={(value) =>
          setQuery({ sort: value === Model3DSort.Newest ? undefined : value })
        }
      />
      {mobile ? (
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
      ) : (
        <Popover
          zIndex={200}
          position="bottom-end"
          shadow="md"
          radius={12}
          opened={opened}
          onClose={close}
          middlewares={{ flip: true, shift: true }}
          withinPortal
        >
          <Popover.Target>{target}</Popover.Target>
          <Popover.Dropdown maw={468} p={0} w="100%">
            <ScrollArea.Autosize
              type="hover"
              mah={'calc(90vh - var(--header-height) - 156px)'}
            >
              {dropdownBody}
            </ScrollArea.Autosize>
            {dropdownFooter}
          </Popover.Dropdown>
        </Popover>
      )}
    </Group>
  );
}
