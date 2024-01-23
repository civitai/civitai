import { Stack, Group, Text, Loader, Center, Divider, Alert } from '@mantine/core';
import { RootThreadProvider, CreateComment, Comment } from '~/components/CommentsV2';
import { trpc } from '~/utils/trpc';
import { useClubContributorStatus } from '../club.utils';

type Props = {
  clubId: number;
  clubPostId: number;
  userId?: number;
};

export function ClubPostDiscussion({ clubId, clubPostId, userId }: Props) {
  return (
    <RootThreadProvider
      entityType="clubPost"
      entityId={clubPostId}
      limit={3}
      badges={userId ? [{ userId, label: 'op', color: 'violet' }] : []}
    >
      {({ data, created, isLoading, remaining, showMore, toggleShowMore }) =>
        isLoading ? (
          <Center>
            <Loader variant="bars" />
          </Center>
        ) : (
          <Stack>
            <CreateComment />
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
    </RootThreadProvider>
  );
}
