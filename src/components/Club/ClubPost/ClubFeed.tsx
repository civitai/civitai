import type { ActionIconProps, MenuItemProps, MenuProps } from '@mantine/core';
import {
  ActionIcon,
  Box,
  Center,
  Divider,
  Group,
  Menu,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import React, { useMemo } from 'react';
import type { ClubPostGetAll, ClubPostResource } from '~/types/router';
import { ImageCSSAspectRatioWrap } from '~/components/Profile/ImageCSSAspectRatioWrap';
import { constants } from '~/server/common/constants';
import { MediaHash } from '~/components/ImageHash/ImageHash';
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
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { ClubPostDiscussion } from '~/components/Club/ClubPost/ClubPostDiscussion';
import { useInView } from '~/hooks/useInView';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { ClubAdminPermission } from '~/shared/utils/prisma/enums';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import type { SupportedClubPostEntities } from '~/server/schema/club.schema';
import { ImageCarousel } from '../../Bounty/ImageCarousel';
import { useIsMobile } from '../../../hooks/useIsMobile';
import { triggerRoutedDialog } from '../../Dialog/RoutedDialogLink';
import { ContentClamp } from '../../ContentClamp/ContentClamp';
import { Reactions } from '../../Reaction/Reactions';
import classes from './ClubFeed.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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
  const queryUtils = trpc.useUtils();
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
          <Text size="sm" c="red">
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
        leftSection={<IconPencilMinus size={14} stroke={1.5} />}
        href={`/clubs/${clubPost.clubId}/posts/${clubPost.id}/edit`}
        component={Link}
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
        leftSection={<IconPencilMinus size={14} stroke={1.5} />}
        href={`/posts/${clubPost.entityId}/edit`}
        component={Link}
      >
        Edit Image Post
      </Menu.Item>
    ) : null,
    canDeletePost ? (
      <Menu.Item
        key="edit"
        leftSection={<IconTrash size={14} stroke={1.5} />}
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
        <LegacyActionIcon
          color="gray"
          radius="xl"
          variant="filled"
          {...buttonProps}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical size={iconSize} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}

export const ClubPostItem = ({ clubPost }: { clubPost: ClubPostGetAll[number] }) => {
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView();
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
      className={clsx(classes.feedContainer, classes.clubPost, {
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
        <Group justify="space-between">
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

  // if (resourceData.entityType === 'Post' && resourceData.data) {
  //   return (
  //     <ImageCarousel
  //       mobile={isMobile}
  //       images={resourceData.data.images}
  //       connectId={resourceData.entityId}
  //       connectType="post"
  //       onClick={(image) => {
  //         triggerRoutedDialog({
  //           name: 'imageDetail',
  //           state: { imageId: image.id, filters: { postId: resourceData.data?.id } },
  //         });
  //       }}
  //     />
  //   );
  // }

  return null;
};
