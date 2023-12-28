import { SupportedClubEntities } from '~/server/schema/club.schema';
import { useEntityAccessRequirement } from '~/components/Club/club.utils';
import {
  Alert,
  Anchor,
  Button,
  ButtonProps,
  List,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  ThemeIconProps,
  Tooltip,
} from '@mantine/core';
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
  const { entities, isLoadingAccess } = useEntityAccessRequirement({
    entityType,
    entityIds: [entityId],
  });

  const [access] = entities;

  const hasAccess = access?.hasAccess ?? false;
  const clubRequirement = access?.clubRequirement;
  const requiresClub = access?.requiresClub;

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
        <Text size="sm" weight="bold">
          This {getDisplayName(entityType)} is exclusive to club supporters.
        </Text>
        {clubs.length > 0 && (
          <Stack>
            <Text size="sm">
              This {getDisplayName(entityType)} is intended as additional content to reward members
              of a creator&rsquo;s club. If you&rsquo;d like to access this{' '}
              {getDisplayName(entityType)} you can sign up for one of the following clubs:
            </Text>
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

export const ClubRequirementIndicator = ({
  entityId,
  entityType,
  ...themeIconProps
}: {
  entityId: number;
  entityType: SupportedClubEntities;
} & Omit<ThemeIconProps, 'children'>) => {
  const features = useFeatureFlags();
  const { entities, isLoadingAccess } = useEntityAccessRequirement({
    entityType,
    entityIds: [entityId],
  });

  const [access] = entities;
  const requiresClub = access?.requiresClub;

  if (isLoadingAccess) {
    return null;
  }

  if (!features.clubs || !requiresClub) {
    // This is a user that can't see clubs yet, so we don't want to show them the club requirement notice
    return null;
  }

  return (
    <ThemeIcon
      radius="xl"
      title={`This ${getDisplayName(entityType)} is only available to club members`}
      {...themeIconProps}
    >
      <IconClubs stroke={2.5} size={16} />
    </ThemeIcon>
  );
};

export const ClubRequirementButton = ({
  entityId,
  entityType,
  label,
  ...actionBtnProps
}: {
  entityId: number;
  entityType: SupportedClubEntities;
} & { label: string } & ButtonProps) => {
  const features = useFeatureFlags();
  const { entities, isLoadingAccess } = useEntityAccessRequirement({
    entityType,
    entityIds: [entityId],
  });

  const [access] = entities ?? [];

  const requiresClub = access?.requiresClub;
  const clubRequirement = access?.clubRequirement;

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

  if (isLoadingAccess || isLoadingClubs) {
    return null;
  }

  if (!requiresClub || !clubs || !clubRequirement) {
    return null;
  }

  return (
    <Menu position="bottom" shadow="md">
      <Menu.Target>
        <Button radius="md" leftIcon={<IconClubs size={16} />} {...actionBtnProps}>
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Clubs</Menu.Label>
        {clubs.map((club) => {
          const requirement = clubRequirement.clubs.find((c) => c.clubId === club.id);

          if (!requirement) {
            return null;
          }

          const requiredTiers = requirement.clubTierIds
            ?.map((id) => club.tiers.find((t) => t.id === id))
            .filter(isDefined);

          return (
            <Menu.Item
              key={club.id}
              onClick={(e) => {
                dialogStore.trigger({
                  component: ManageClubMembershipModal,
                  props: {
                    clubId: club.id,
                    clubTierIds:
                      requiredTiers.length > 0 ? requiredTiers.map((t) => t.id) : undefined,
                  },
                });
              }}
            >
              <Stack spacing={0}>
                <Text>
                  {club.name} by {club.user.username}{' '}
                </Text>
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
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
};
