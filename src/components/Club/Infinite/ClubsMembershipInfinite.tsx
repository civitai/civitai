import {
  ActionIcon,
  Center,
  Divider,
  Group,
  List,
  Loader,
  LoadingOverlay,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { NoContent } from '~/components/NoContent/NoContent';
import { InViewLoader } from '~/components/InView/InViewLoader';
import {
  useClubContributorStatus,
  useMutateClub,
  useQueryClubMembership,
} from '~/components/Club/club.utils';
import { GetInfiniteClubMembershipsSchema } from '~/server/schema/clubMembership.schema';
import { ClubMembershipSort } from '~/server/common/enums';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { formatDate } from '~/utils/date-helpers';
import { IconClock, IconTrash, IconX } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { ClubMembershipRole, Currency } from '@prisma/client';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { constants } from '~/server/common/constants';
import { getDisplayName } from '~/utils/string-helpers';

export function ClubMembershipInfinite({ clubId, showEof = true }: Props) {
  // TODO.clubs: Add some custom filters for members.
  const [filters, setFilters] = useState<
    Omit<GetInfiniteClubMembershipsSchema, 'limit' | 'cursor' | 'clubId'>
  >({
    sort: ClubMembershipSort.MostRecent,
  });

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { memberships, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    useQueryClubMembership(clubId, debouncedFilters);

  const { isModerator, isOwner } = useClubContributorStatus({ clubId });

  const {
    removeAndRefundMember,
    removingAndRefundingMember,
    updateClubMembership,
    updatingClubMembership,
  } = useMutateClub();

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);

  const onRemoveAndRefundMember = async (membership: (typeof memberships)[number]) => {
    openConfirmModal({
      title: 'Remove and refund member',
      children: (
        <Stack>
          <Text size="sm">
            Are you sure you want to remove and refund this member? This action is destructive and
            cannot be reverted.
          </Text>
          <Text size="sm">
            <Text weight="bold" component="span">
              {membership.user.username}
            </Text>{' '}
            will be removed from this club and refunded the last payment of{' '}
            <Text weight="bold" component="span">
              <CurrencyBadge
                unitAmount={membership.unitAmount}
                currency={membership.currency ?? Currency.BUZZ}
              />
            </Text>
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Remove & refund', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: removingAndRefundingMember },
      onConfirm: async () => {
        await removeAndRefundMember({
          userId: membership.user.id,
          clubId,
        });

        showSuccessNotification({
          title: 'Member removed',
          message: `${membership.user.username} has been removed from this club.`,
        });
      },
    });
  };

  const onUpdateMembershipRole = async (
    membership: (typeof memberships)[number],
    role: ClubMembershipRole
  ) => {
    if (role === membership.role) return;

    if (
      (role === ClubMembershipRole.Admin || membership.role === ClubMembershipRole.Admin) &&
      !(isOwner || isModerator)
    ) {
      showErrorNotification({
        title: 'Unauthorized',
        error: new Error('You are not authorized to perform this action.'),
      });

      return;
    }

    const isRoleUpgrade =
      constants.clubs.clubMembershipRoleHiearchy.indexOf(role) <
      constants.clubs.clubMembershipRoleHiearchy.indexOf(membership.role);

    const featureBase = isRoleUpgrade ? role : membership.role;

    const features =
      featureBase === ClubMembershipRole.Admin
        ? constants.clubs.adminMembershipFeatures
        : featureBase === ClubMembershipRole.Contributor
        ? constants.clubs.contributorMembershipFeatures
        : [];

    const featureList = (
      <List spacing="xs" size="sm">
        {features.map((feature) => (
          <List.Item key={feature}>{feature}</List.Item>
        ))}
      </List>
    );

    openConfirmModal({
      title: 'Update membership role',
      children: (
        <Stack>
          <Text size="sm">Are you sure you want to update this member role?</Text>
          {isRoleUpgrade ? (
            <Text size="sm">
              The user{' '}
              <Text weight="bold" component="span">
                {membership.user.username}
              </Text>{' '}
              will be upgraded to {getDisplayName(role)} and gain access to the following features:
            </Text>
          ) : (
            <Text size="sm">
              The user{' '}
              <Text weight="bold" component="span">
                {membership.user.username}
              </Text>{' '}
              will be downgraded to {getDisplayName(role)} and lose access to the following
              features:
            </Text>
          )}
          {featureList}
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Update membership', cancel: 'Cancel' },
      confirmProps: { loading: updatingClubMembership },
      onConfirm: async () => {
        await updateClubMembership({
          clubTierId: membership.clubTier.id,
          userId: membership.user.id,
          role,
        });

        showSuccessNotification({
          title: 'Membership updated',
          message: `User ${membership.user.username} has been assigned a new role.`,
        });
      },
    });
  };

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
                  <td>
                    <Select
                      aria-label="Membership role"
                      data={Object.values(ClubMembershipRole).map((role) => ({
                        label: role,
                        value: role,
                      }))}
                      value={membership.role}
                      onChange={(value: ClubMembershipRole) =>
                        onUpdateMembershipRole(membership, value)
                      }
                    />
                  </td>
                  <td>{formatDate(membership.startedAt)}</td>
                  <td>{formatDate(membership.nextBillingAt)}</td>
                  <td>
                    {isOwner || isModerator ? (
                      <Group>
                        <Tooltip label="Remove and refund last payment">
                          <ActionIcon
                            size="sm"
                            color="red"
                            variant="transparent"
                            onClick={() => onRemoveAndRefundMember(membership)}
                            loading={removingAndRefundingMember}
                          >
                            <IconTrash />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    ) : null}
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
                    No more members to show.
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
        <NoContent message="It looks like no members have joined your club yet. You will start seeing results here as members come in" />
      )}
    </>
  );
}

type Props = { clubId: number; showEof?: boolean };
