import { Stack, Group, Text, Loader, Center, Divider, Alert } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';
import { trpc } from '~/utils/trpc';
import { useClubContributorStatus } from '../club.utils';

type Props = {
  clubId: number;
  clubPostId: number;
  userId?: number;
};

export function ClubPostDiscussion({ clubId, clubPostId, userId }: Props) {
  const { data: membership, isLoading: isLoadingMembership } =
    trpc.clubMembership.getClubMembershipOnClub.useQuery({
      clubId,
    });
  const { isOwner, isClubAdmin, isModerator } = useClubContributorStatus({ clubId });

  const canComment = membership || isClubAdmin || isOwner || isModerator;

  return (
    <CommentsProvider
      entityType="clubPost"
      entityId={clubPostId}
      limit={3}
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading || isLoadingMembership ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            {canComment ? (
              <CreateComment />
            ) : (
              <Alert>
                <Group align="center" position="center" spacing="xs">
                  <Text size="sm">You must be a member of this club to add a comment</Text>
                </Group>
              </Alert>
            )}
            {(data?.length || created.length) > 0 && (
              <>
                {data?.map((comment) => (
                  <Comment key={comment.id} comment={comment} />
                ))}
                {!!remaining && !showMore && (
                  <Divider
                    label={
                      <Group spacing="xs" align="center">
                        <Text variant="link" sx={{ cursor: 'pointer' }} onClick={toggleShowMore}>
                          Show {remaining} More
                        </Text>
                      </Group>
                    }
                    labelPosition="center"
                    variant="dashed"
                  />
                )}
                {created.map((comment) => (
                  <Comment key={comment.id} comment={comment} />
                ))}
              </>
            )}
          </Stack>
        )
      }
    </CommentsProvider>
  );
}
