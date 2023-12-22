import { SupportedClubEntities } from '~/server/schema/club.schema';
import { useEntityAccessRequirement } from '~/components/Club/club.utils';
import { Alert, Anchor, List, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconClubs } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { useFeatureFlags } from '../../providers/FeatureFlagsProvider';
import { getDisplayName } from '../../utils/string-helpers';
import { dialogStore } from '../Dialog/dialogStore';
import { ManageClubMembershipModal } from './ClubMemberships/ManageClubMembershipModal';
import { LoginPopover } from '../LoginPopover/LoginPopover';

export const ClubRequirementNotice = ({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: SupportedClubEntities;
}) => {
  const features = useFeatureFlags();
  const { hasAccess, requiresClub, clubRequirement, isLoadingAccess } = useEntityAccessRequirement({
    entityType,
    entityId,
  });

  const { data, isLoading: isLoadingClubs } = trpc.club.getInfinite.useQuery(
    {
      clubIds: clubRequirement?.clubs?.map((c) => c.clubId),
      include: ['tiers'],
    },
    {
      enabled: requiresClub && (clubRequirement?.clubs?.length ?? 0) > 0 && features.clubs,
    }
  );

  const clubs = data?.items;

  if (isLoadingAccess) {
    return null;
  }

  if (!features.clubs && !hasAccess) {
    // This is a user that can't see clubs yet, so we don't want to show them the club requirement notice
    return (
      <Alert color="blue">
        <Stack spacing={4}>
          <ThemeIcon radius="xl">
            <IconClubs />
          </ThemeIcon>
          <Text size="sm">This {getDisplayName(entityType)} is private.</Text>
          <Text size="sm">
            The creator has decided to make this resource private and only available to specific
            people. You can request access by contacting the creator.
          </Text>
        </Stack>
      </Alert>
    );
  }

  if (isLoadingClubs) {
    return null;
  }

  if (hasAccess || !requiresClub || !clubs || !clubRequirement) {
    return null;
  }

  return (
    <Alert color="blue">
      <Stack spacing={4}>
        <ThemeIcon radius="xl">
          <IconClubs />
        </ThemeIcon>
        <Text size="sm">
          This {getDisplayName(entityType)} requires a club membership to access.
        </Text>
        {clubs.length > 0 && (
          <Stack>
            <Text size="sm">To get access to this resource, join one of these creator clubs:</Text>
            <List size="xs" spacing={8}>
              {clubs.map((club) => {
                const requirement = clubRequirement.clubs.find((c) => c.clubId === club.id);

                if (!requirement) {
                  return null;
                }

                const requiredTiers = requirement.clubTierIds
                  ?.map((id) => club.tiers.find((t) => t.id === id))
                  .filter(isDefined);

                return (
                  <List.Item key={club.id}>
                    <Stack spacing={0}>
                      <LoginPopover>
                        <Anchor
                          onClick={(e) => {
                            dialogStore.trigger({
                              component: ManageClubMembershipModal,
                              props: {
                                clubId: club.id,
                                clubTierIds:
                                  requiredTiers.length > 0
                                    ? requiredTiers.map((t) => t.id)
                                    : undefined,
                              },
                            });
                          }}
                          span
                        >
                          {club.name} by {club.user.username}{' '}
                        </Anchor>
                      </LoginPopover>
                      {requiredTiers.length > 0 && (
                        <Text size="xs">
                          Only available on tiers:{' '}
                          {requiredTiers.map((tier, idx) => (
                            <Text key={tier.id} component="span">
                              {idx !== 0 && ', '} {tier.name}
                            </Text>
                          ))}
                        </Text>
                      )}
                    </Stack>
                  </List.Item>
                );
              })}
            </List>
          </Stack>
        )}
      </Stack>
    </Alert>
  );
};
