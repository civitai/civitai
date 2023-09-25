import { Stack, Group, Text, Loader, Center, Divider, Paper } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';

type Props = {
  bountyId: number;
  userId?: number;
};

export function BountyDiscussion({ bountyId, userId }: Props) {
  return (
    <CommentsProvider
      entityType="bounty"
      entityId={bountyId}
      limit={20}
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
    </CommentsProvider>
  );
}
