import type { GroupProps } from '@mantine/core';
import { Center, Group, Loader, Popover } from '@mantine/core';
import { IconWorld } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SortFilter } from '~/components/Filters/SortFilter';
import { buildHubFilterSave } from '~/components/Hubs/hub-filter-save';
import { toPanelHub, useInvalidateHub } from '~/components/Hubs/hub.utils';
import { useHubSort } from '~/components/Hubs/useHubSort';
import {
  useHubSessionFeedFilters,
  useSetHubSessionFeedFilters,
} from '~/components/Hubs/hub-session.store';
import { hubExcludedFilterKeys } from '~/components/Image/Filters/media-filter-keys';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubFeedFiltersSchema, hubSortSchema } from '~/server/schema/user-hub.schema';
import { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const HubSourcePanel = dynamic(
  () => import('~/components/Hubs/HubSourcePanel').then((m) => m.HubSourcePanel),
  {
    ssr: false,
    loading: () => (
      <Center py="md">
        <Loader size="sm" />
      </Center>
    ),
  }
);

/**
 * Sort and filters for a hub, rendered in the sub-nav where every other feed puts
 * them, and using the same controls the images feed uses. Controlled rather than
 * store-backed: these belong to the hub and persist with it, so they must not be
 * shared with whatever the user last picked on /images.
 *
 * Sources appear both here and in the rail on purpose, until we learn which one
 * people use.
 */
export function HubFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const hubId = Number(router.query.id);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const invalidateHub = useInvalidateHub();

  const { data: hub } = trpc.userHub.getById.useQuery(
    { id: hubId },
    { enabled: Number.isInteger(hubId) }
  );
  const sessionFilters = useHubSessionFeedFilters(hubId);
  const setSessionFilters = useSetHubSessionFeedFilters();

  // The owner's stored values are the starting point for everyone; a viewer's own
  // choices sit on top for this session only.
  const effective = {
    sort: (hub?.isOwner ? hub.sort : sessionFilters.sort ?? hub?.sort) as string | undefined,
    period: (hub?.isOwner ? hub.period : sessionFilters.period ?? hub?.period) as
      | MetricTimeframe
      | undefined,
    types: hub?.isOwner ? hub.mediaTypes : sessionFilters.types ?? hub?.mediaTypes,
    filters: hub?.isOwner ? hub.filters : sessionFilters.filters ?? hub?.filters,
  };
  const sort = useHubSort(effective.sort);

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: () => invalidateHub(hubId),
    onError: (error) =>
      showErrorNotification({ title: 'Could not save hub', error: new Error(error.message) }),
  });

  if (!hub) return null;

  // On a hub you do not own, the only source count that means anything is the one
  // contributing to the feed: the owner's switched-off rows are not shown.
  const sourceCount = hub.isOwner
    ? hub.sources.length
    : hub.sources.filter((source) => source.enabled).length;

  return (
    <Group className={classes.filtersWrapper} gap={8} wrap="nowrap" {...groupProps}>
      {/* The app theme defaults Popover to withinPortal:false, and the sub-nav
          clips — so this one says so explicitly. */}
      <Popover
        position="bottom-end"
        withinPortal
        shadow="md"
        width={340}
        opened={sourcesOpen}
        onChange={setSourcesOpen}
      >
        <Popover.Target>
          <FilterButton
            icon={IconWorld}
            active={sourcesOpen}
            // Controlled Popover, so the target does not toggle itself.
            onClick={() => setSourcesOpen((open) => !open)}
          >
            {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
          </FilterButton>
        </Popover.Target>
        <Popover.Dropdown p="sm">
          {/* The panel scrolls its own source list and pins what follows, so the
              duplicate button reads as a footer instead of sitting at the bottom of a
              list that can be fifty rows long. */}
          <HubSourcePanel
            hub={toPanelHub(hub)}
            // Opening the picker in here pushes the popover past its own height and
            // it starts scrolling inside a scroll. Adding lives in the rail.
            hideAdd
            listMaxHeight={340}
          />
        </Popover.Dropdown>
      </Popover>

      {/* Shown on a hub you do not own as well: these narrow the feed in front of
          you, they are not source controls and not the owner's curation. The owner's
          choices persist; a viewer's are session state, because `upsert` is
          owner-scoped and would refuse them. */}
      <SortFilter
        type="images"
        value={sort}
        options={hubSortSchema.options.map((value) => ({ label: value, value }))}
        onChange={(value) =>
          hub.isOwner
            ? upsert.mutate({ id: hub.id, sort: value as HubSort, period: hub.period })
            : setSessionFilters(hub.id, { sort: value })
        }
      />
      <MediaFiltersDropdown
        w="100%"
        filterType="images"
        isFeed
        size="compact-sm"
        exclude={hubExcludedFilterKeys}
        query={{
          ...effective.filters,
          period: effective.period,
          types: effective.types,
        }}
        onChange={(next) =>
          hub.isOwner
            ? upsert.mutate(buildHubFilterSave(hub.id, next))
            : setSessionFilters(hub.id, {
                period: (next.period ?? MetricTimeframe.AllTime) as MetricTimeframe,
                types: (next.types ?? []) as MediaType[],
                filters: hubFeedFiltersSchema.parse(next),
              })
        }
      />
    </Group>
  );
}
