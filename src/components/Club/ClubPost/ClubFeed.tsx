import {
  ActionIcon,
  ActionIconProps,
  Box,
  Center,
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
import React, { useMemo } from 'react';
import { ClubPostGetAll, ClubPostResource } from '~/types/router';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
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
import { openConfirmModal } from '@mantine/modals';
import { isDefined } from '~/utils/type-guards';
import { NextLink } from '@mantine/next';
import { ClubPostDiscussion } from '~/components/Club/ClubPost/ClubPostDiscussion';
import { useInView } from '~/hooks/useInView';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ClubAdminPermission } from '@prisma/client';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { SupportedClubPostEntities } from '~/server/schema/club.schema';
import { ImageCarousel } from '../../Bounty/ImageCarousel';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { triggerRoutedDialog } from '../../Dialog/RoutedDialogProvider';
import { ContentClamp } from '../../ContentClamp/ContentClamp';
import { Reactions } from '../../Reaction/Reactions';

export const useClubFeedStyles = createStyles((theme) => ({
  feedContainer: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
  },
  clubPost: {
    maxWidth: 700,
    width: '100%',
  },
  feedContainerWithCover: {
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    padding: 0,
  },
  title: {
    overflowWrap: 'break-word',
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

  const { isOwner, permissions } = useClubContributorStatus({
    clubId: clubPost.clubId,
  });

  const canUpdatePost =
    isModerator || isOwner || permissions.includes(ClubAdminPermission.ManagePosts);
  const canDeletePost =
    isModerator || isOwner || permissions.includes(ClubAdminPermission.ManagePosts);

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
            This action is not reversible
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
    canUpdatePost &&
    clubPost.entityType === 'Post' &&
    'data' in clubPost &&
    (clubPost.data?.user?.id === currentUser?.id || isModerator) ? (
      <Menu.Item
        key="edit"
        icon={<IconPencilMinus size={14} stroke={1.5} />}
        href={`/posts/${clubPost.entityId}/edit`}
        component={NextLink}
      >
        Edit Image Post
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
  const { classes, cx } = useClubFeedStyles();
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const { metrics, reactions } = clubPost;

  const { title, description } = useMemo(() => {
    if (clubPost.title) {
      return clubPost;
    }

    if (clubPost.entityType === 'Post' && 'data' in clubPost) {
      return {
        title: clubPost.data?.title ?? '',
        description: clubPost.data?.detail ?? '',
      };
    }

    return clubPost;
  }, [clubPost]);

  if (
    clubPost &&
    clubPost.entityId &&
    clubPost.entityType &&
    (!('data' in clubPost) || !clubPost.data)
  ) {
    return null;
  }

  return (
    <Paper
      className={cx(classes.feedContainer, classes.clubPost, {
        [classes.feedContainerWithCover]: !!clubPost.coverImage,
      })}
    >
      {/* {clubPost.coverImage && (
        <ImageGuard
          images={[clubPost.coverImage]}
          connect={{ entityId: clubPost.coverImage.id, entityType: 'club' }}
          render={(image) => {
            return (
              <ImageGuard.Content>
                {({ safe }) => (
                  <div style={{ width: '100%', position: 'relative' }}>
                    {!safe ? (
                      <MediaHash {...image} style={{ width: '100%', height: '100%' }} />
                    ) : (
                      <ImagePreview
                        image={image}
                        edgeImageProps={{ width: 1600 }}
                        radius="md"
                        style={{ width: '100%', height: '100%' }}
                        aspectRatio={0}
                      />
                    )}
                    <ImageGuard.ToggleConnect position="top-left" />
                    <ImageGuard.Report withinPortal />
                  </div>
                )}
              </ImageGuard.Content>
            );
          }}
        />
      )} */}
      <Stack p="md">
        <Title order={3} className={classes.title} ref={ref}>
          {title}
        </Title>
        <Group position="apart">
          <UserAvatar
            user={clubPost.createdBy}
            subText={clubPost.createdAt ? `Created at ${formatDate(clubPost.createdAt)}` : ''}
            withUsername
          />

          <ClubPostContextMenu clubPost={clubPost} />
        </Group>
        {!!clubPost.entityType && !!clubPost.entityId && (
          <ClubPostResourceCard
            resourceData={{
              ...clubPost,
              entityId: clubPost.entityId as number,
              entityType: clubPost.entityType as SupportedClubPostEntities,
            }}
          />
        )}
        {description && (
          <>
            <ContentClamp maxHeight={400}>
              <RenderHtml html={description} />
            </ContentClamp>
            <Divider />
          </>
        )}
        <Reactions
          entityId={clubPost.id}
          entityType="clubPost"
          reactions={reactions}
          metrics={{
            likeCount: metrics?.likeCount,
            heartCount: metrics?.heartCount,
            laughCount: metrics?.laughCount,
            cryCount: metrics?.cryCount,
          }}
          targetUserId={currentUser?.id}
        />
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

export const ClubPostResourceCard = ({ resourceData }: { resourceData: ClubPostResource }) => {
  const isMobile = useIsMobile();

  if (!('data' in resourceData)) {
    return null;
  }

  if (
    (resourceData.entityType === 'ModelVersion' || resourceData.entityType === 'Model') &&
    resourceData.data
  ) {
    return (
      <Center>
        <Box style={{ maxWidth: 250, width: '100%' }}>
          <ModelCard
            data={{ ...resourceData.data, image: resourceData?.data?.images[0] ?? null } as any}
          />
        </Box>
      </Center>
    );
  }

  if (resourceData.entityType === 'Article' && resourceData.data) {
    return (
      <Center>
        <Box style={{ maxWidth: 250, width: '100%' }}>
          <ArticleCard data={resourceData.data} />
        </Box>
      </Center>
    );
  }

  if (resourceData.entityType === 'Post' && resourceData.data) {
    return (
      <ImageCarousel
        mobile={isMobile}
        images={resourceData.data.images}
        connectId={resourceData.entityId}
        connectType="post"
        onClick={(image) => {
          triggerRoutedDialog({
            name: 'imageDetail',
            state: { imageId: image.id, filters: { postId: resourceData.data?.id } },
          });
        }}
      />
    );
  }

  return null;
};
