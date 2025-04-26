import { Group, Modal, Stack, UnstyledButton, Text } from '@mantine/core';
import { useDialogContext } from '../Dialog/DialogProvider';
import { dialogStore } from '../Dialog/dialogStore';
import { IconFile, IconPencilMinus, IconPictureInPicture } from '@tabler/icons-react';
// import { ClubPostUpsertFormModal } from './ClubPost/ClubPostUpsertForm';
import { AddResourceToClubModal } from './AddResourceToClubModal';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { useClubContributorStatus } from './club.utils';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRouter } from 'next/router';
import styles from './ClubAddContent.module.scss';

export const ClubAddContent = ({ clubId }: { clubId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const router = useRouter();
  const { isOwner, isModerator, isClubAdmin, permissions } = useClubContributorStatus({
    clubId,
  });

  const canCreatePosts =
    isOwner || isModerator || permissions.includes(ClubAdminPermission.ManagePosts);

  const canCreateResources = isOwner || isClubAdmin;

  const noActions = !canCreatePosts && !canCreateResources;

  return (
    <Modal {...dialog} title="Add content to this club" size="sm" withCloseButton>
      <Stack>
        <Group position="apart">
          {canCreatePosts && (
            <UnstyledButton
              className={styles.button}
              onClick={() => {
                // dialogStore.trigger({
                //   component: ClubPostUpsertFormModal,
                //   props: {
                //     clubId,
                //   },
                // });

                handleClose();
              }}
            >
              <Stack align="center">
                <IconPencilMinus />
                <Text size="sm">Text Post</Text>
              </Stack>
            </UnstyledButton>
          )}
          {canCreatePosts && (
            <UnstyledButton
              onClick={() => {
                router.push(`/posts/create?clubId=${clubId}&returnUrl=${router.asPath}`);
                handleClose();
              }}
              className={styles.button}
            >
              <Stack align="center">
                <IconPictureInPicture />
                <Text size="sm">Image Post</Text>
              </Stack>
            </UnstyledButton>
          )}
          {canCreateResources && (
            <UnstyledButton
              className={styles.button}
              onClick={() => {
                dialogStore.trigger({
                  component: AddResourceToClubModal,
                  props: {
                    clubId,
                  },
                });

                handleClose();
              }}
            >
              <Stack align="center">
                <IconFile />
                <Text size="sm">Resource</Text>
              </Stack>
            </UnstyledButton>
          )}
        </Group>
        {noActions && (
          <Text size="sm" color="dimmed">
            You don&rsquo;t have permissions to add content to this club.
          </Text>
        )}
      </Stack>
    </Modal>
  );
};

