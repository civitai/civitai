import { Center, Loader, Stack, Text } from '@mantine/core';
import { EntityType } from '~/shared/utils/prisma/enums';
import { EntityCollaboratorList } from '~/components/EntityCollaborator/EntityCollaboratorList';
import {
  useEntityCollaboratorsMutate,
  useGetEntityCollaborators,
} from '~/components/EntityCollaborator/entityCollaborator.util';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import type { PostDetailEditable } from '~/server/services/post.service';

export const PostCollaboratorSelection = ({ post }: { post: PostDetailEditable }) => {
  const currentUser = useCurrentUser();

  const { collaborators } = useGetEntityCollaborators({
    entityType: EntityType.Post,
    entityId: post.id,
  });

  const { upsertEntityCollaborator, upsertingEntityCollaborator } = useEntityCollaboratorsMutate();

  const isLoading = upsertingEntityCollaborator;

  return (
    <Stack gap="xs">
      <Text size="lg" fw={500}>
        Invite Collaborators
      </Text>
      <Text size="sm" c="dimmed">
        Invite your teammates or collaborators to be shown on this post and get credit for it. If
        they accept the invite, it will be shown on their profile in addition to yours. Tipped Buzz
        will be split equally. A maximum of {constants.entityCollaborators.maxCollaborators}{' '}
        collaborators can be invited.
      </Text>
      <QuickSearchDropdown
        disableInitialSearch
        supportedIndexes={['users']}
        onItemSelected={(_entity, item) => {
          const selected = item as SearchIndexDataMap['users'][number];
          if (collaborators.find((c) => c.user.id === selected.id)) {
            return;
          }

          upsertEntityCollaborator({
            entityId: post.id,
            entityType: EntityType.Post,
            targetUserId: selected.id,
            sendMessage: post.publishedAt ? true : false,
          });
        }}
        dropdownItemLimit={25}
        showIndexSelect={false}
        startingIndex="users"
        placeholder="Select community members to invite as a collaborator"
        filters={[
          { id: currentUser?.id },
          ...collaborators.map((c) => ({
            id: c.user.id,
          })),
        ]
          .filter((x) => !!x?.id)
          .map((x) => `AND NOT id=${x.id}`)
          .join(' ')
          .slice(4)}
        disabled={isLoading}
      />

      {isLoading && (
        <Center>
          <Loader />
        </Center>
      )}

      <EntityCollaboratorList
        entityId={post.id}
        entityType={EntityType.Post}
        isEntityOwner
        creatorCardProps={{
          statDisplayOverwrite: [],
        }}
      />
    </Stack>
  );
};
