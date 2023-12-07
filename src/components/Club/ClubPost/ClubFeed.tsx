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
import { useClubContributorStatus } from '~/components/Club/club.utils';
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

  const { isOwner, role } = useClubContributorStatus({
    clubId: clubPost.clubId,
  });

  const canUpdatePost =
    isModerator ||
    isOwner ||
    (clubPost.createdBy?.id === currentUser?.id && role === ClubMembershipRole.Contributor) ||
    role === ClubMembershipRole.Admin;

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
        {inView && <ClubPostDiscussion clubPostId={clubPost.id} userId={currentUser?.id} />}
      </Stack>
    </Paper>
  );
};
