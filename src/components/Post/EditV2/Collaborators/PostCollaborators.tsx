import { Center, Loader, Stack, Text } from '@mantine/core';
import { EntityType } from '@prisma/client';
import { EntityCollaboratorList } from '~/components/EntityCollaborator/EntityCollaboratorList';
import {
  useEntityCollaboratorsMutate,
  useGetEntityCollaborators,
} from '~/components/EntityCollaborator/entityCollaborator.util';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostDetailEditable } from '~/server/services/post.service';

export const PostCollaboratorSelection = ({ post }: { post: PostDetailEditable }) => {
  const currentUser = useCurrentUser();

  const { collaborators } = useGetEntityCollaborators({
    entityType: EntityType.Post,
    entityId: post.id,
  });

  const { upsertEntityCollaborator, upsertingEntityCollaborator } = useEntityCollaboratorsMutate();

  const isLoading = upsertingEntityCollaborator;

  return (
    <Stack spacing="xs">
      <Text size="lg" weight={500}>
        Invite collaborators
      </Text>
      <Text size="sm" color="dimmed">
        If they accept, their user will be shown in the post &amp; image details accordingly. This
        post &amp; images will also be shown in their profile.
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
        placeholder="Select users to collaborate with"
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
