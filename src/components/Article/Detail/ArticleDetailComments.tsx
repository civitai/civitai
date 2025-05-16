import { Stack, Group, Text, Loader, Center, Divider, Title, Button, Modal } from '@mantine/core';
import { RootThreadProvider, CreateComment, Comment } from '~/components/CommentsV2';

import classes from '~/components/CommentsV2/Comment/Comment.module.scss';
import { IconAlertCircle, IconMessageCancel } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useState } from 'react';
import { SortFilter } from '../../Filters';
import { ThreadSort } from '../../../server/common/enums';
import { ReturnToRootThread } from '../../CommentsV2/ReturnToRootThread';

type ArticleDetailCommentsProps = {
  articleId: number;
  userId: number;
};

export function ArticleDetailComments({ articleId, userId }: ArticleDetailCommentsProps) {
  const [opened, setOpened] = useState(false);

  return (
    <>
      <RootThreadProvider
        entityType="article"
        entityId={articleId}
        limit={20}
        badges={[{ userId, label: 'op', color: 'violet' }]}
      >
        {({
          data,
          created,
          isLoading,
          remaining,
          showMore,
          hiddenCount,
          toggleShowMore,
          sort,
          setSort,
          activeComment,
        }) => (
          <Stack mt="xl" gap="xl">
            <Stack gap={0}>
              <Group justify="space-between">
                <Group gap="md">
                  <Title order={2} id="comments">
                    Comments
                  </Title>
                  {hiddenCount > 0 && !isLoading && (
                    <Button variant="subtle" onClick={() => setOpened(true)} size="compact-xs">
                      <Group gap={4} justify="center">
                        <IconMessageCancel size={16} />
                        <Text inherit inline>
                          {`See ${hiddenCount} more hidden ${
                            hiddenCount > 1 ? 'comments' : 'comment'
                          }`}
                        </Text>
                      </Group>
                    </Button>
                  )}
                </Group>
                <SortFilter
                  type="threads"
                  value={sort}
                  onChange={(v) => setSort(v as ThreadSort)}
                />
              </Group>
              <ReturnToRootThread />
            </Stack>
            {isLoading ? (
              <Center mt="xl">
                <Loader variant="bars" />
              </Center>
            ) : (
              <>
                {activeComment && (
                  <Stack gap="xl">
                    <Divider />
                    <Text size="sm" color="dimmed">
                      Viewing thread for
                    </Text>
                    <Comment comment={activeComment} viewOnly />
                  </Stack>
                )}
                <Stack
                  gap="xl"
                  className={activeComment ? classes.rootCommentReplyInset : undefined}
                >
                  <CreateComment />
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                  ))}
                  {!!remaining && !showMore && (
                    <Divider
                      label={
                        <Group gap="xs" align="center">
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
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                  ))}
                </Stack>
              </>
            )}
          </Stack>
        )}
      </RootThreadProvider>
      <HiddenCommentsModal
        opened={opened}
        onClose={() => setOpened(false)}
        entityId={articleId}
        userId={userId}
      />
    </>
  );
}

type HiddenCommentsModalProps = {
  opened: boolean;
  onClose: () => void;
  entityId: number;
  userId: number;
};

const HiddenCommentsModal = ({ opened, onClose, entityId, userId }: HiddenCommentsModalProps) => {
  return (
    <Modal
      title="Hidden Comments"
      size="md"
      radius="lg"
      opened={opened}
      onClose={onClose}
      closeButtonProps={{
        'aria-label': 'Close hidden comments',
      }}
      withCloseButton
    >
      <Divider mx="-md" />
      <Stack mt="md" gap="xl">
        <AlertWithIcon icon={<IconAlertCircle />}>
          Some comments may be hidden by the author or moderators to ensure a positive and inclusive
          environment. Moderated for respectful and relevant discussions.
        </AlertWithIcon>
        {opened && (
          <RootThreadProvider
            entityType="article"
            entityId={entityId}
            limit={20}
            badges={[{ userId, label: 'op', color: 'violet' }]}
            hidden
          >
            {({ data, isLoading, remaining, showMore, toggleShowMore }) =>
              isLoading ? (
                <Center mt="xl">
                  <Loader variant="bars" />
                </Center>
              ) : !!data?.length ? (
                <Stack gap="xl">
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
                  ))}
                  {!!remaining && !showMore && (
                    <Divider
                      label={
                        <Group gap="xs" align="center">
                          <Text variant="link" sx={{ cursor: 'pointer' }} onClick={toggleShowMore}>
                            Show {remaining} More
                          </Text>
                        </Group>
                      }
                      labelPosition="center"
                      variant="dashed"
                    />
                  )}
                </Stack>
              ) : (
                <Text>No hidden comments</Text>
              )
            }
          </RootThreadProvider>
        )}
      </Stack>
    </Modal>
  );
};
