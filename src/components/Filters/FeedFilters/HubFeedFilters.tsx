import type { GroupProps } from '@mantine/core';
import { Group } from '@mantine/core';
import { useRouter } from 'next/router';
import { PeriodFilter } from '~/components/Filters';
import { SortFilter } from '~/components/Filters/SortFilter';
import { ImageSort } from '~/server/common/enums';
import type { HubSort } from '~/server/schema/user-hub.schema';
import { hubSortSchema } from '~/server/schema/user-hub.schema';
import type { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Sort and period for a hub, rendered in the sub-nav where every other feed
 * puts them. Controlled rather than store-backed: these belong to the hub and
 * persist with it, so they must not be shared with whatever the user last picked
 * on /images.
 */
export function HubFeedFilters({ ...groupProps }: GroupProps) {
  const router = useRouter();
  const hubId = Number(router.query.id);
  const utils = trpc.useUtils();

  const { data: hub } = trpc.userHub.getById.useQuery(
    { id: hubId },
    { enabled: Number.isInteger(hubId) }
  );

  const upsert = trpc.userHub.upsert.useMutation({
    onSuccess: async () => {
      await utils.userHub.getById.invalidate({ id: hubId });
      await utils.image.getInfinite.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save hub', error: new Error(error.message) }),
  });

  if (!hub) return null;

  const sort = hubSortSchema.catch(ImageSort.Newest).parse(hub.sort);

  const save = (changes: { sort?: HubSort; period?: MetricTimeframe }) =>
    upsert.mutate({
      id: hub.id,
      name: hub.name,
      sort: changes.sort ?? sort,
      period: changes.period ?? hub.period,
      sources: hub.sources.map(({ id: _id, ...source }) => source),
    });

  return (
    <Group gap={4} wrap="nowrap" {...groupProps}>
      <SortFilter
        type="images"
        value={sort}
        options={hubSortSchema.options.map((value) => ({ label: value, value }))}
        onChange={(value) => save({ sort: value as HubSort })}
      />
      <PeriodFilter
        type="images"
        value={hub.period}
        onChange={(value) => save({ period: value })}
      />
    </Group>
  );
}
