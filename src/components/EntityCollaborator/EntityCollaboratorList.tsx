import { Center, Group, Loader, Stack, Button, Text } from '@mantine/core';
import { EntityCollaboratorStatus, EntityType } from '@prisma/client';
import { CreatorCardV2, CreatorCardPropsV2 } from '~/components/CreatorCard/CreatorCard';
import {
  useGetEntityCollaborators,
  useEntityCollaboratorsMutate,
} from '~/components/EntityCollaborator/entityCollaborator.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const EntityCollaboratorList = ({
  entityId,
  entityType,
  isEntityOwner,
  creatorCardProps,
}: {
  entityId: number;
  entityType: EntityType;
  isEntityOwner?: boolean;
  creatorCardProps?: Partial<CreatorCardPropsV2>;
}) => {
  const currentUser = useCurrentUser();
  const { collaborators, isLoading } = useGetEntityCollaborators({
    entityId,
    entityType,
  });

  const {
    removeEntityCollaborator,
    removingEntityCollaborator,
    actionEntityCollaborator,
    actioningEntityCollaborator,
  } = useEntityCollaboratorsMutate();

  const isOwnerOrMod = isEntityOwner || currentUser?.isModerator;

  if (isLoading) {
    return (
      <Center>
        <Loader variant="bars" />
      </Center>
    );
  }
  return (
    <Stack>
      {collaborators.map((collaborator) => {
        const isInvitee = currentUser?.id === collaborator.user.id;
        const showInvitionActions =
          isInvitee && collaborator.status === EntityCollaboratorStatus.Pending;

        return (
          <Stack key={collaborator.user.id} spacing={0}>
            {collaborator.status !== EntityCollaboratorStatus.Pending && isOwnerOrMod && (
              <Text size="xs" color="dimmed">
                {collaborator.status === EntityCollaboratorStatus.Approved
                  ? 'User Approved Collaboration'
                  : 'User Rejected Collaboration'}
              </Text>
            )}
            <CreatorCardV2 user={collaborator.user} withActions={false} {...creatorCardProps} />
            {showInvitionActions && (
              <Button.Group w="100%">
                <Button
                  onClick={() => {
                    actionEntityCollaborator({
                      entityId,
                      entityType,
                      status: EntityCollaboratorStatus.Approved,
                    });
                  }}
                  loading={actioningEntityCollaborator}
                  compact
                  w="100%"
                >
                  Accept invite
                </Button>
                <Button
                  color="red"
                  onClick={() => {
                    actionEntityCollaborator({
                      entityId,
                      entityType,
                      status: EntityCollaboratorStatus.Rejected,
                    });
                  }}
                  loading={actioningEntityCollaborator}
                  compact
                  variant="outline"
                  w="100%"
                >
                  Reject invite
                </Button>
              </Button.Group>
            )}
            {isOwnerOrMod && (
              <Stack spacing={0}>
                <Button
                  onClick={() => {
                    removeEntityCollaborator({
                      entityId,
                      entityType,
                      targetUserId: collaborator.user.id,
                    });
                  }}
                  loading={removingEntityCollaborator}
                  compact
                  color="red"
                  mt="xs"
                >
                  Remove collaborator
                </Button>
              </Stack>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
};
