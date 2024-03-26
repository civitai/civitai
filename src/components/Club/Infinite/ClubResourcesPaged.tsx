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
import { ClubResourcePagedUpdateForm } from '~/components/Club/ClubResourcePagedUpdateForm';
import { showSuccessNotification } from '~/utils/notifications';

export function ClubResourcesPaged({ clubId }: Props) {
  const utils = trpc.useContext();

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
  });

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  const handleResourceRemoved = (resource: ClubResourceGetPaginatedItem) => {
    utils.club.getPaginatedClubResources.setData(
      {
        ...debouncedFilters,
        clubId,
      },
      (prev) => {
        if (!prev) return prev;

        return {
          ...prev,
          items: prev.items.filter(
            (item) => item.entityId !== resource.entityId || item.entityType !== resource.entityType
          ),
        };
      }
    );

    showSuccessNotification({ title: 'Resource removed', message: 'Resource removed from club.' });
  };

  const handleResourceUpdated = (resource: ClubResourceGetPaginatedItem) => {
    showSuccessNotification({
      title: 'Resource updated',
      message: 'Resource has been updated successfuly.',
    });
  };

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
                <th>All members</th>
                {tiers.map((tier) => (
                  <th key={tier.id}>{tier.name}</th>
                ))}
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {resources.map((resource) => {
                return (
                  <ClubResourcePagedUpdateForm
                    resource={resource}
                    clubTiers={tiers}
                    key={`${resource.entityType}_${resource.entityId}`}
                    onResourceRemoved={handleResourceRemoved}
                    onResourceUpdated={handleResourceUpdated}
                  />
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
