import type { GroupProps } from '@mantine/core';
import { Center, Group, Loader, Popover, ScrollArea } from '@mantine/core';
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
import { hubExcludedFilterKeys } from '~/components/Image/Filters/media-filter-keys';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubSortSchema } from '~/server/schema/user-hub.schema';
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
  const sort = useHubSort(hub?.sort);

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
          <ScrollArea.Autosize mah={400}>
            <HubSourcePanel
              hub={toPanelHub(hub)}
              // Opening the picker in here pushes the popover past its own height
              // and it starts scrolling inside a scroll. Adding lives in the rail.
              hideAdd
            />
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>

      {/* Sort and the filter menu write straight to the hub, and `upsert` is
          owner-scoped — so on someone else's hub they would be controls that error.
          Content level and source toggles are the two things a viewer changes here,
          and both live in the sources panel above. */}
      {hub.isOwner && (
        <>
          <SortFilter
            type="images"
            value={sort}
            options={hubSortSchema.options.map((value) => ({ label: value, value }))}
            onChange={(value) =>
              upsert.mutate({ id: hub.id, sort: value as HubSort, period: hub.period })
            }
          />
          <MediaFiltersDropdown
            w="100%"
            filterType="images"
            isFeed
            size="compact-sm"
            exclude={hubExcludedFilterKeys}
            query={{
              ...hub.filters,
              period: hub.period,
              types: hub.mediaTypes,
            }}
            onChange={(next) => upsert.mutate(buildHubFilterSave(hub.id, next))}
          />
        </>
      )}
    </Group>
  );
}
