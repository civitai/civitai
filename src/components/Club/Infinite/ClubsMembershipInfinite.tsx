import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import {
  Center,
  Divider,
  Group,
  List,
  Loader,
  LoadingOverlay,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { InViewLoader } from '~/components/InView/InViewLoader';
import {
  useClubFilters,
  useQueryClubMembership,
  useQueryClubs,
} from '~/components/Club/club.utils';
import { ClubCard } from '~/components/Club/ClubCard';
import { GetInfiniteClubSchema } from '~/server/schema/club.schema';
import { GetInfiniteClubMembershipsSchema } from '~/server/schema/clubMembership.schema';
import { ClubMembershipSort } from '~/server/common/enums';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { IconClock } from '@tabler/icons-react';

export function ClubMembershipInfinite({ clubId, showEof = true }: Props) {
  const [filters, setFilters] = useState<
    Omit<GetInfiniteClubMembershipsSchema, 'limit' | 'cursor' | 'clubId'>
  >({
    sort: ClubMembershipSort.MostRecent,
  });

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { memberships, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    useQueryClubMembership(clubId, debouncedFilters);

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!memberships.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <Table>
            <thead>
              <tr>
                <th>User</th>
                <th>Tier</th>
                <th>Role</th>
                <th>Member since</th>
                <th>Next billing date</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((membership) => (
                <tr key={membership.id}>
                  <td>
                    <UserAvatar user={membership.user} withUsername />
                  </td>
                  <td>{membership.clubTier.name}</td>
                  <td>{membership.role}</td>
                  <td>{formatDate(membership.startedAt)}</td>
                  <td>{formatDate(membership.nextBillingAt)}</td>
                  <td>
                    <Text variant="link" size="sm">
                      Remove &amp; refund last payment
                    </Text>
                  </td>
                </tr>
              ))}
            </tbody>
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isRefetching}
                style={{ gridColumn: '1/-1' }}
              >
                <Center p="xl" sx={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </Table>
          {!hasNextPage && showEof && (
            <Stack mt="xl">
              <Divider
                size="sm"
                label={
                  <Group spacing={4}>
                    <IconClock size={16} stroke={1.5} />
                    You are all caught up
                  </Group>
                }
                labelPosition="center"
                labelProps={{ size: 'sm' }}
              />
              <Center>
                <Stack spacing={0} align="center">
                  <Text
                    variant="link"
                    size="sm"
                    onClick={() => {
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    sx={{ cursor: 'pointer' }}
                  >
                    Back to the top
                  </Text>
                </Stack>
              </Center>
            </Stack>
          )}
        </div>
      ) : (
        <NoContent />
      )}
    </>
  );
}

type Props = { clubId: number; showEof?: boolean };
