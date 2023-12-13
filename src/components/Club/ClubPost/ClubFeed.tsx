import {
  ActionIcon,
  ActionIconProps,
  createStyles,
  Divider,
  Group,
  Menu,
  MenuItemProps,
  MenuProps,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import React from 'react';
import { ClubPostGetAll } from '~/types/router';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { formatDate } from '~/utils/date-helpers';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useClubContributorStatus, useMutateClub } from '~/components/Club/club.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRouter } from 'next/router';
import { useMutateBounty } from '~/components/Bounty/bounty.utils';
import {
  IconDotsVertical,
  IconEdit,
  IconPencilMinus,
  IconReceiptRefund,
  IconTrash,
} from '@tabler/icons-react';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import Link from 'next/link';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { isDefined } from '~/utils/type-guards';
import { ClubMembershipRole } from '@prisma/client';
import { NextLink } from '@mantine/next';
import { ClubPostDiscussion } from '~/components/Club/ClubPost/ClubPostDiscussion';
import { useInView } from '~/hooks/useInView';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useClubFeedStyles = createStyles((theme) => ({
  feedContainer: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
  },
  title: {
    [theme.fn.smallerThan('sm')]: {
      fontSize: '24px',
    },
  },
}));

export function ClubPostContextMenu({
  clubPost,
  buttonProps: { iconSize, ...buttonProps } = { iconSize: 16 },
  ...menuProps
}: MenuProps & {
  clubPost: ClubPostGetAll[number];
  buttonProps?: ActionIconProps & { iconSize?: number };
}) {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;
  const queryUtils = trpc.useContext();
  const { deleteClubPost, deletingClubPost } = useMutateClub();

  const { isOwner, role } = useClubContributorStatus({
    clubId: clubPost.clubId,
  });

  const canUpdatePost =
    isModerator ||
    isOwner ||
    (clubPost.createdBy?.id === currentUser?.id && role === ClubMembershipRole.Contributor) ||
    role === ClubMembershipRole.Admin;

  const canDeletePost = isModerator || isOwner || role === ClubMembershipRole.Admin;

  const handleDeletePost = () => {
    const onDelete = async () => {
      await deleteClubPost({ id: clubPost.id });

      showSuccessNotification({
        title: 'Success',
        message: 'Post deleted successfully',
      });

      await queryUtils.clubPost.getInfiniteClubPosts.invalidate();
    };

    openConfirmModal({
      title: 'Delete Club Post',
      children: (
        <Stack>
          <Text>Are you sure you want to delete this club post?</Text>
          <Text size="sm" color="red">
            This action not reversible
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { confirm: 'Delete club post', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: onDelete,
    });
  };

  const menuItems: React.ReactElement<MenuItemProps>[] = [
    canUpdatePost ? (
      <Menu.Item
        key="edit"
        icon={<IconPencilMinus size={14} stroke={1.5} />}
        href={`/clubs/${clubPost.clubId}/posts/${clubPost.id}/edit`}
        component={NextLink}
      >
        Edit
      </Menu.Item>
    ) : null,
    canDeletePost ? (
      <Menu.Item
        key="edit"
        icon={<IconTrash size={14} stroke={1.5} />}
        onClick={handleDeletePost}
        color="red"
      >
        Delete post
      </Menu.Item>
    ) : null,
  ].filter(isDefined);

  if (!menuItems.length) return null;

  return (
    <Menu {...menuProps}>
      <Menu.Target>
        <ActionIcon
          color="gray"
          radius="xl"
          variant="filled"
          {...buttonProps}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical size={iconSize} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}

export const ClubPostItem = ({ clubPost }: { clubPost: ClubPostGetAll[number] }) => {
  const { classes } = useClubFeedStyles();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({
    triggerOnce: true,
  });

  return (
    <Paper className={classes.feedContainer}>
      <Stack>
        {clubPost.coverImage && (
          <ImageCSSAspectRatioWrap aspectRatio={constants.clubs.postCoverImageAspectRatio}>
            <ImageGuard
              images={[clubPost.coverImage]}
              connect={{ entityId: clubPost.coverImage.id, entityType: 'club' }}
              render={(image) => {
                return (
                  <ImageGuard.Content>
                    {({ safe }) => (
                      <>
                        {!safe ? (
                          <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                        ) : (
                          <ImagePreview
                            image={image}
                            edgeImageProps={{ width: 450 }}
                            radius="md"
                            style={{ width: '100%', height: '100%' }}
                            aspectRatio={0}
                          />
                        )}
                        <div style={{ width: '100%', height: '100%' }}>
                          <ImageGuard.ToggleConnect position="top-left" />
                          <ImageGuard.Report withinPortal />
                        </div>
                      </>
                    )}
                  </ImageGuard.Content>
                );
              }}
            />
          </ImageCSSAspectRatioWrap>
        )}
        <Title order={3} className={classes.title} ref={ref}>
          {clubPost.title}
        </Title>
        <Group position="apart">
          <UserAvatar
            user={clubPost.createdBy}
            subText={clubPost.createdAt ? `Created at ${formatDate(clubPost.createdAt)}` : ''}
            withUsername
          />

          <ClubPostContextMenu clubPost={clubPost} />
        </Group>
        <RenderHtml html={clubPost.description} />
        <Divider />
        {inView && (
          <ClubPostDiscussion
            clubId={clubPost.clubId}
            clubPostId={clubPost.id}
            userId={currentUser?.id}
          />
        )}
      </Stack>
    </Paper>
  );
};
