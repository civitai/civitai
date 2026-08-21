import type { GroupProps } from '@mantine/core';
import { Center, Group, Loader, Popover, ScrollArea } from '@mantine/core';
import { IconWorld } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { FilterButton } from '~/components/Buttons/FilterButton';
import classes from '~/components/Filters/FeedFilters/FeedFilters.module.scss';
import { SortFilter } from '~/components/Filters/SortFilter';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { ImageSort } from '~/server/common/enums';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubFeedFiltersSchema, hubLimits, hubSortSchema } from '~/server/schema/user-hub.schema';
import type { MediaType, MetricTimeframe } from '~/shared/utils/prisma/enums';
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
 * Sources appear both here and in the rail on purpose — which one people reach
 * for is the open question, so both are live until there is an answer.
 */
export function HubFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const hubId = Number(router.query.id);
  // Mantine's Popover.Target does not toggle on click by itself.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const utils = trpc.useUtils();

  const { data: hub } = trpc.userHub.getById.useQuery(
    { id: hubId },
    { enabled: Number.isInteger(hubId) }
  );

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await utils.userHub.getById.invalidate({ id: hubId });
      // Scoped to this hub: an unkeyed invalidate refetches every mounted
      // image.getInfinite query, not only the feed behind this filter.
      await utils.image.getInfinite.invalidate({ hubId });
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save hub', error: new Error(error.message) }),
  });

  if (!hub) return null;

  const sort = hubSortSchema.catch(ImageSort.Newest).parse(hub.sort);
  const sourceCount = hub.sources.length;

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
            onClick={() => setSourcesOpen((open) => !open)}
          >
            {sourceCount} {sourceCount === 1 ? 'source' : 'sources'}
          </FilterButton>
        </Popover.Target>
        <Popover.Dropdown p="sm">
          <ScrollArea.Autosize mah={400}>
            <HubSourcePanel
              hubId={hub.id}
              maxSources={hubLimits.sourcesPerHub}
              sources={hub.sources.map(({ id: _id, ...source }) => source)}
            />
          </ScrollArea.Autosize>
        </Popover.Dropdown>
      </Popover>

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
        query={{
          ...hub.filters,
          period: hub.period,
          types: hub.mediaTypes,
        }}
        // Only the keys a hub can persist survive; the dropdown renders a few
        // more (hidden, scheduled, the moderation toggles) that are per-session
        // states rather than settings this hub carries.
        onChange={(next) =>
          upsert.mutate({
            id: hub.id,
            sort,
            period: (next.period ?? hub.period) as MetricTimeframe,
            mediaTypes: (next.types ?? []) as MediaType[],
            filters: hubFeedFiltersSchema.parse(next),
          })
        }
      />
    </Group>
  );
}
