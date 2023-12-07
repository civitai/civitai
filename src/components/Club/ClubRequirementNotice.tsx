import { SupportedClubEntities, SupportedClubEntitiesLabels } from '~/server/schema/club.schema';
import { useEntityAccessRequirement } from '~/components/Club/club.utils';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Anchor, List, Stack, Text } from '@mantine/core';
import { IconClubs } from '@tabler/icons-react';
import { trpc } from '~/utils/trpc';
import { useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';

export const ClubRequirementNotice = ({
  entityId,
  entityType,
}: {
  entityId: number;
  entityType: SupportedClubEntities;
}) => {
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
      enabled: requiresClub && (clubRequirement?.clubs?.length ?? 0) > 0,
    }
  );

  const clubs = data?.items;

  if (isLoadingAccess || isLoadingClubs) {
    return null;
  }

  if (hasAccess || !requiresClub || !clubs || !clubRequirement) {
    return null;
  }

  return (
    <AlertWithIcon color="blue" icon={<IconClubs />} size="md">
      <Text size="sm">
        This {SupportedClubEntitiesLabels[entityType]} requires a club membership to access.
      </Text>
      {clubs.length > 0 && (
        <Stack>
          <Text size="sm">To get access to this resource, join one of these creator clubs:</Text>
          <List size="xs" spacing={8}>
            {clubs.map((club) => {
              const requirement = clubRequirement.clubs.find((c) => c.clubId === club.id);
              console.log(
                clubRequirement.clubs.find((c) => console.log(c, club)),
                requirement
              );

              if (!requirement) {
                return null;
              }

              const requiredTiers = requirement.clubTierIds
                ?.map((id) => club.tiers.find((t) => t.id === id))
                .filter(isDefined);

              return (
                <List.Item key={club.id}>
                  <Stack spacing={0}>
                    <Anchor href={`/clubs/${club.id}`} span>
                      {club.name} by {club.user.username}{' '}
                    </Anchor>
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
    </AlertWithIcon>
  );
};
