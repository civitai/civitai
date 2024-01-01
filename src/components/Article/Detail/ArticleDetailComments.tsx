import { Stack, Group, Text, Loader, Center, Divider, Title, Button, Modal } from '@mantine/core';
import { CommentsProvider, CreateComment, Comment } from '~/components/CommentsV2';
import { IconAlertCircle, IconMessageCancel } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { useState } from 'react';
import { useEntityAccessRequirement } from '../../Club/club.utils';

type ArticleDetailCommentsProps = {
  articleId: number;
  userId: number;
};

export function ArticleDetailComments({ articleId, userId }: ArticleDetailCommentsProps) {
  const [opened, setOpened] = useState(false);
  const { entities } = useEntityAccessRequirement({
    entityType: 'Article',
    entityIds: [articleId],
  });
  const [access] = entities;
  const hasAccess = access?.hasAccess ?? false;

  return (
    <>
      <CommentsProvider
        entityType="article"
        entityId={articleId}
        limit={20}
        badges={[{ userId, label: 'op', color: 'violet' }]}
        forceLocked={!hasAccess}
      >
        {({ data, created, isLoading, remaining, showMore, hiddenCount, toggleShowMore }) =>
          isLoading ? (
            <Center mt="xl">
              <Loader variant="bars" />
            </Center>
          ) : (
            <Stack mt="xl" spacing="xl">
              <Group spacing="md">
                <Title order={2} id="comments">
                  Comments
                </Title>
                {hiddenCount > 0 && (
                  <Button variant="subtle" size="xs" onClick={() => setOpened(true)} compact>
                    <Group spacing={4} position="center">
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
              <CreateComment />
              {data?.map((comment) => (
                <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
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
                <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
              ))}
            </Stack>
          )
        }
      </CommentsProvider>
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
      closeButtonLabel="Close hidden comments"
      withCloseButton
    >
      <Divider mx="-md" />
      <Stack mt="md" spacing="xl">
        <AlertWithIcon icon={<IconAlertCircle />}>
          Some comments may be hidden by the author or moderators to ensure a positive and inclusive
          environment. Moderated for respectful and relevant discussions.
        </AlertWithIcon>
        {opened && (
          <CommentsProvider
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
                <Stack spacing="xl">
                  {data?.map((comment) => (
                    <Comment key={comment.id} comment={comment} resourceOwnerId={userId} />
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
                </Stack>
              ) : (
                <Text>No hidden comments</Text>
              )
            }
          </CommentsProvider>
        )}
      </Stack>
    </Modal>
  );
};
