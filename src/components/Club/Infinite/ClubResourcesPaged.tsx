import {
  ActionIcon,
  Anchor,
  Center,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  LoadingOverlay,
  Pagination,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { NoContent } from '~/components/NoContent/NoContent';
import { useMutateClub, useQueryClubResources } from '~/components/Club/club.utils';
import { IconTrash } from '@tabler/icons-react';
import { GetPaginatedClubResourcesSchema } from '~/server/schema/club.schema';
import { ClubResourceGetPaginatedItem } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { matureLabel } from '~/components/Post/Edit/EditPostControls';

const getResourceTitle = (
  resource: ClubResourceGetPaginatedItem
): { label: string; url: string } => {
  switch (resource.entityType) {
    case 'ModelVersion':
      return {
        label: `${resource.data.name} - ${resource.data.modelVersion.name}`,
        url: `/models/${resource.data.id}?modelVersion=${resource.data.modelVersion.id}`,
      };
    case 'Article':
      return {
        label: resource.data.title,
        url: `/articles/${resource.data.id}`,
      };
  }
};

export function ClubResourcesPaged({ clubId }: Props) {
  // TODO.clubs: Add some custom filters for resources. Model type and perhaps a query of sorts.
  const [filters, setFilters] = useState<Omit<GetPaginatedClubResourcesSchema, 'limit' | 'clubId'>>(
    {
      page: 1,
    }
  );

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { resources, pagination, isLoading, isRefetching } = useQueryClubResources(
    clubId,
    debouncedFilters
  );

  const { data: tiers = [], isLoading: isLoadingTiers } = trpc.club.getTiers.useQuery({
    clubId,
    include: ['membershipsCount'],
  });

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading || isLoadingTiers ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!resources.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <Table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Resource</th>
                {tiers.map((tier) => (
                  <th key={tier.id}>{tier.name}</th>
                ))}
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => {
                const { label, url } = getResourceTitle(resource);
                return (
                  <tr key={`${resource.entityType}_${resource.entityId}`}>
                    <td>{resource.entityType}</td>
                    <td>
                      <Anchor href={url} target="_blank">
                        {label}
                      </Anchor>
                    </td>
                    {tiers.map((tier) => (
                      <td key={tier.id}>
                        <Checkbox
                          checked={resource.clubTierIds.includes(tier.id)}
                          onChange={() => console.log('TODO: Add resource to tier')}
                          m="auto"
                        />
                      </td>
                    ))}
                    <td>Remove me</td>
                  </tr>
                );
              })}
            </tbody>
            {pagination && pagination.totalPages > 1 && (
              <Group position="apart">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  page={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </Table>
        </div>
      ) : (
        <NoContent message="It looks like there are no resources in this club. Add resources to have them show up." />
      )}
    </>
  );
}

type Props = { clubId: number };
