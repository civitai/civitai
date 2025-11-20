import { Menu, useComputedColorScheme } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { showNotification, updateNotification } from '@mantine/notifications';
import {
  IconArrowBackUp,
  IconBan,
  IconCrystalBall,
  IconDotsVertical,
  IconFlag,
  IconInfoCircle,
  IconGraphOff,
  IconGraph,
  IconMicrophone,
  IconMicrophoneOff,
  IconX,
} from '@tabler/icons-react';
import React from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
// import { ProfileHeader } from '~/components/Profile/ProfileHeader';
// import ProfileLayout from '~/components/Profile/ProfileLayout';
import UserBanModal from '~/components/Profile/UserBanModal';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { EncryptedDataSchema } from '~/server/schema/civToken.schema';
import { impersonateEndpoint } from '~/shared/constants/auth.constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { showErrorNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const UserContextMenu = ({ username }: { username: string }) => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { swapAccount, setOgAccount } = useAccountContext();

  const { data: user, isLoading: userLoading } = trpc.user.getCreator.useQuery(
    { username },
    { enabled: username !== constants.system.user.username }
  );
  const isMod = currentUser && currentUser.isModerator;
  const isSameUser =
    !!currentUser &&
    !!currentUser.username &&
    postgresSlugify(currentUser.username) === postgresSlugify(username);
  const removeContentMutation = trpc.user.removeAllContent.useMutation();
  // const deleteAccountMutation = trpc.user.delete.useMutation({
  //   onSuccess() {
  //     showSuccessNotification({
  //       title: 'Account Deleted',
  //       message: 'This account has been deleted.',
  //     });
  //   },
  // });

  const toggleBanMutation = trpc.user.toggleBan.useMutation({
    async onMutate() {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser
          ? {
              ...prevUser,
              bannedAt: prevUser.bannedAt ? null : new Date(),
            }
          : undefined
      );

      return { prevUser };
    },
    async onSuccess() {
      await queryUtils.userProfile.get.invalidate({ username });
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to ban user, please try again.'),
      });
    },
  });

  const toggleMuteMutation = trpc.user.toggleMute.useMutation({
    async onMutate() {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser
          ? {
              ...prevUser,
              muted: !prevUser.muted,
            }
          : undefined
      );

      return { prevUser };
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to mute user, please try again.'),
      });
    },
  });

  const toggleLeaderboardMutation = trpc.user.setLeaderboardEligibility.useMutation({
    async onMutate({ setTo }) {
      await queryUtils.user.getCreator.cancel({ username });

      const prevUser = queryUtils.user.getCreator.getData({ username });
      queryUtils.user.getCreator.setData({ username }, () =>
        prevUser ? { ...prevUser, excludeFromLeaderboards: setTo } : undefined
      );

      return { prevUser };
    },
    onError(_error, _vars, context) {
      queryUtils.user.getCreator.setData({ username }, context?.prevUser);
      showErrorNotification({
        error: new Error('Unable to remove user from leaderboards, please try again.'),
      });
    },
  });

  const colorScheme = useComputedColorScheme('dark');

  const handleToggleMute = () => {
    if (user) toggleMuteMutation.mutate({ id: user.id });
  };
  const handleToggleBan = () => {
    if (user) {
      if (user.bannedAt) toggleBanMutation.mutate({ id: user.id });
      else
        dialogStore.trigger({
          component: UserBanModal,
          props: { userId: user.id, username: user.username as string },
        });
    }
  };
  const handleToggleLeaderboardEligibility = () => {
    if (!user) return;
    if (user.excludeFromLeaderboards)
      toggleLeaderboardMutation.mutate({ id: user.id, setTo: !user.excludeFromLeaderboards });
    else
      openConfirmModal({
        title: 'Remove from Leaderboards',
        children: `Are you sure you want to remove this user from leaderboards? This will take effect at the next refresh.`,
        labels: { confirm: 'Yes, remove from leaderboards', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onConfirm: () =>
          toggleLeaderboardMutation.mutate({ id: user.id, setTo: !user.excludeFromLeaderboards }),
      });
  };
  // const handleRemoveContent = () => {
  //   if (!user) return;
  //   openConfirmModal({
  //     title: 'Remove All Content',
  //     children: `Are you sure you want to remove all content (models, reviews, comments, posts, and images) by this user? This action cannot be undone.`,
  //     labels: { confirm: 'Yes, remove all content', cancel: 'Cancel' },
  //     confirmProps: { color: 'red' },
  //     onConfirm: () => removeContentMutation.mutate({ id: user.id }),
  //   });
  // };
  // const handleDeleteAccount = () => {
  //   if (!user) return;
  //   openConfirmModal({
  //     title: 'Delete Account',
  //     children: `Are you sure you want to delete this account? This action cannot be undone.`,
  //     labels: { confirm: 'Yes, delete account', cancel: 'Cancel' },
  //     confirmProps: { color: 'red' },
  //     onConfirm: () => deleteAccountMutation.mutate({ id: user.id }),
  //   });
  // };
  const handleImpersonate = async () => {
    if (!user || !currentUser || !features.impersonation || user.id === currentUser?.id) return;
    const notificationId = `impersonate-${user.id}`;

    showNotification({
      id: notificationId,
      loading: true,
      autoClose: false,
      title: 'Switching accounts...',
      message: `-> ${user.username as string} (${user.id})`,
    });

    const tokenResp = await fetch(`${impersonateEndpoint}?${QS.stringify({ userId: user.id })}`);
    if (!tokenResp.ok) {
      const errMsg = await tokenResp.text();
      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to switch',
        message: errMsg,
      });
      return;
    }

    const tokenJson: { token: EncryptedDataSchema } = await tokenResp.json();

    setOgAccount({ id: currentUser.id, username: currentUser.username ?? '(unk)' });
    await swapAccount(tokenJson.token);
  };

  if (userLoading || !user) {
    return null;
  }

  return (
    <Menu position="left-start" withinPortal>
      <Menu.Target>
        <LegacyActionIcon
          loading={removeContentMutation.isLoading}
          size={30}
          radius="xl"
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          ml="auto"
        >
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <>
          {isMod && (
            <>
              {env.NEXT_PUBLIC_USER_LOOKUP_URL && (
                <Menu.Item
                  component="a"
                  target="_blank"
                  leftSection={<IconInfoCircle size={14} stroke={1.5} />}
                  href={`${env.NEXT_PUBLIC_USER_LOOKUP_URL}${user.id}`}
                >
                  Lookup User
                </Menu.Item>
              )}
              {features.impersonation && user.id !== currentUser.id && (
                <Menu.Item
                  color="yellow"
                  leftSection={<IconCrystalBall size={14} stroke={1.5} />}
                  onClick={handleImpersonate}
                >
                  Impersonate User
                </Menu.Item>
              )}
              <Menu.Item
                color={user.bannedAt ? 'green' : 'red'}
                leftSection={
                  !user.bannedAt ? (
                    <IconBan size={14} stroke={1.5} />
                  ) : (
                    <IconArrowBackUp size={14} stroke={1.5} />
                  )
                }
                onClick={handleToggleBan}
              >
                {user.bannedAt ? 'Restore user' : 'Ban user'}
              </Menu.Item>
              <Menu.Item
                color={user.excludeFromLeaderboards ? 'green' : 'red'}
                leftSection={
                  !user.excludeFromLeaderboards ? (
                    <IconGraphOff size={14} stroke={1.5} />
                  ) : (
                    <IconGraph size={14} stroke={1.5} />
                  )
                }
                onClick={handleToggleLeaderboardEligibility}
              >
                {user.excludeFromLeaderboards
                  ? 'Include in leaderboards'
                  : 'Exclude from leaderboards'}
              </Menu.Item>
              {/* <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} stroke={1.5} />}
                onClick={handleRemoveContent}
              >
                Remove all content
              </Menu.Item> */}
              {/* <Menu.Item
                color="red"
                leftSection={<IconUserMinus size={14} stroke={1.5} />}
                onClick={handleDeleteAccount}
              >
                Delete Account
              </Menu.Item> */}
              <Menu.Item
                leftSection={
                  user.muted ? (
                    <IconMicrophone size={14} stroke={1.5} />
                  ) : (
                    <IconMicrophoneOff size={14} stroke={1.5} />
                  )
                }
                onClick={handleToggleMute}
              >
                {user.muted ? 'Unmute user' : 'Mute user'}
              </Menu.Item>
            </>
          )}
          {!isSameUser && <BlockUserButton userId={user.id} as="menu-item" />}
          {isSameUser && (
            <Menu.Item component={Link} href={`/user/${username}/manage-categories`}>
              Manage model categories
            </Menu.Item>
          )}
          <HideUserButton as="menu-item" userId={user.id} />
          <LoginRedirect reason="report-user">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openReportModal({
                  entityType: ReportEntity.User,
                  entityId: user.id,
                })
              }
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        </>
      </Menu.Dropdown>
    </Menu>
  );
};
