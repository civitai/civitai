import type { GroupProps } from '@mantine/core';
import { Group, Popover, Stack, Switch } from '@mantine/core';
import { IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { Model3DSort } from '~/server/schema/model3d.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { getDisplayName } from '~/utils/string-helpers';

/**
 * Sub-nav filter row for the /3d-models feed. Mirrors `ImageFeedFilters` —
 * a Sort menu, a Period menu, and a Filters popover that surfaces the
 * polyGen-specific Rigged / Animated toggles. All state lives on the URL so
 * deep links + back/forward preserve the active filter set.
 */
const SORT_VALUES = new Set<string>(Object.values(Model3DSort));
const PERIOD_VALUES = new Set<string>(Object.values(MetricTimeframe));

const sortOptions = Object.values(Model3DSort).map((v) => ({ label: v, value: v }));
const periodOptions = (Object.values(MetricTimeframe) as MetricTimeframe[]).map((p) => ({
  label: getDisplayName(p),
  value: p,
}));

export function Model3DFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const { query } = router;

  const sort = useMemo<Model3DSort>(() => {
    const raw = typeof query.sort === 'string' ? query.sort : undefined;
    return raw && SORT_VALUES.has(raw) ? (raw as Model3DSort) : Model3DSort.Newest;
  }, [query.sort]);

  const period = useMemo<MetricTimeframe>(() => {
    const raw = typeof query.period === 'string' ? query.period : undefined;
    return raw && PERIOD_VALUES.has(raw) ? (raw as MetricTimeframe) : MetricTimeframe.AllTime;
  }, [query.period]);

  const rigged = query.rigged === 'true';
  const animated = query.animated === 'true';
  const activeFilterCount = (rigged ? 1 : 0) + (animated ? 1 : 0);

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
      <SelectMenuV2
        label={getDisplayName(period)}
        value={period}
        options={periodOptions}
        onClick={(value) =>
          setQuery({ period: value === MetricTimeframe.AllTime ? undefined : value })
        }
      />
      <Popover position="bottom-end" withinPortal width={220}>
        <Popover.Target>
          <FilterButton icon={IconFilter} active={activeFilterCount > 0} size="sm">
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </FilterButton>
        </Popover.Target>
        <Popover.Dropdown>
          <Stack gap="sm">
            <Switch
              label="Rigged"
              checked={rigged}
              onChange={(e) =>
                setQuery({ rigged: e.currentTarget.checked ? 'true' : undefined })
              }
            />
            <Switch
              label="Animated"
              checked={animated}
              onChange={(e) =>
                setQuery({ animated: e.currentTarget.checked ? 'true' : undefined })
              }
            />
          </Stack>
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}
