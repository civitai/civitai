import {
  Group,
  Modal,
  Stack,
  UnstyledButton,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDialogContext } from '../Dialog/DialogContext';
import { dialogStore } from '../Dialog/dialogStore';
import { IconFile, IconPencilMinus, IconPictureInPicture } from '@tabler/icons-react';
// import { ClubPostUpsertFormModal } from './ClubPost/ClubPostUpsertForm';
import { AddResourceToClubModal } from './AddResourceToClubModal';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { useClubContributorStatus } from './club.utils';
import { useRouter } from 'next/router';

export const ClubAddContent = ({ clubId }: { clubId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const router = useRouter();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { isOwner, isModerator, isClubAdmin, permissions } = useClubContributorStatus({
    clubId,
  });

  const btnStyle = {
    background: colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    width: '150px',
  };

  const canCreatePosts =
    isOwner || isModerator || permissions.includes(ClubAdminPermission.ManagePosts);

  const canCreateResources = isOwner || isClubAdmin;

  const noActions = !canCreatePosts && !canCreateResources;

  return (
    <Modal {...dialog} title="Add content to this club" size="sm" withCloseButton>
      <Stack>
        <Group justify="space-between">
          {canCreatePosts && (
            <UnstyledButton
              style={btnStyle}
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
              style={btnStyle}
            >
              <Stack align="center">
                <IconPictureInPicture />
                <Text size="sm">Image Post</Text>
              </Stack>
            </UnstyledButton>
          )}
          {canCreateResources && (
            <UnstyledButton
              style={btnStyle}
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
          <Text size="sm" c="dimmed">
            You don&rsquo;t have permissions to add content to this club.
          </Text>
        )}
      </Stack>
    </Modal>
  );
};
