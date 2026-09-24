import type { ButtonProps } from '@mantine/core';
import { Button, Menu, Stack, Switch, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconUserCancel, IconUserCheck } from '@tabler/icons-react';
import { useState } from 'react';
import type { MouseEventHandler } from 'react';
import { blockToast } from '~/components/HideUserButton/block-toast';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useHiddenPreferencesData, useToggleHiddenPreferences } from '~/hooks/hidden-preferences';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showSuccessNotification, showWarningNotification } from '~/utils/notifications';

export function BlockUserButton({
  userId,
  as = 'button',
  onToggleHide,
  label,
  unblockLabel,
  ...props
}: Props) {
  const currentUser = useCurrentUser();

  const users = useHiddenPreferencesData().blockedUsers;
  const isBlocked = users.some((x) => x.id === userId);
  const toggleHiddenMutation = useToggleHiddenPreferences();

  const handleBlockClick: MouseEventHandler<HTMLElement> = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (isBlocked) {
      toggleHiddenMutation
        .mutateAsync({
          kind: 'blockedUser',
          data: [{ id: userId }],
          hidden: !isBlocked,
        })
        .then(() => {
          showSuccessNotification({
            title: isBlocked ? 'User unblocked' : 'blocked',
            message: `Content from this user will${isBlocked ? ' ' : ' not'} show up in your feed`,
          });
        });
    } else {
      const options = { hideComments: false };
      openConfirmModal({
        title: 'Block User',
        children: (
          <BlockUserModalBody onHideCommentsChange={(value) => (options.hideComments = value)} />
        ),
        labels: { confirm: 'Yes, block the user', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onConfirm: () =>
          toggleHiddenMutation
            .mutateAsync({
              kind: 'blockedUser',
              data: [{ id: userId }],
              hidden: true,
              hideComments: options.hideComments,
            })
            .then(({ commentsHidden }) => {
              const { kind, title, message } = blockToast(commentsHidden);
              if (kind === 'warning') showWarningNotification({ title, message, autoClose: 10000 });
              else showSuccessNotification({ title, message });
            }),
      });
    }

    onToggleHide?.();
  };

  if (currentUser != null && userId === currentUser.id) return null;

  return as === 'button' ? (
    <LoginRedirect reason="hide-content">
      <Button
        variant={isBlocked ? 'outline' : 'filled'}
        onClick={handleBlockClick}
        loading={toggleHiddenMutation.isPending}
        {...props}
      >
        {isBlocked ? unblockLabel ?? 'Unblock' : label ?? 'Block'}
      </Button>
    </LoginRedirect>
  ) : (
    <LoginRedirect reason="hide-content">
      <Menu.Item
        onClick={handleBlockClick}
        color={props.color}
        leftSection={
          isBlocked ? (
            <IconUserCheck size={16} stroke={1.5} />
          ) : (
            <IconUserCancel size={16} stroke={1.5} />
          )
        }
      >
        {isBlocked ? unblockLabel ?? 'Unblock this user' : label ?? 'Block this user'}
      </Menu.Item>
    </LoginRedirect>
  );
}

function BlockUserModalBody({
  onHideCommentsChange,
}: {
  onHideCommentsChange: (value: boolean) => void;
}) {
  const [hideComments, setHideComments] = useState(false);

  return (
    <Stack gap="md">
      <Text size="sm">
        Are you sure you want to block this user? Once a user is blocked, you won&apos;t see their
        content again and they won&apos;t see yours.
      </Text>
      <Switch
        checked={hideComments}
        onChange={(e) => {
          setHideComments(e.currentTarget.checked);
          onHideCommentsChange(e.currentTarget.checked);
        }}
        label="Also hide their comments on my content"
        description="Their comments stay hidden if you unblock them. You can show any one of them again."
      />
    </Stack>
  );
}

type Props = Omit<ButtonProps, 'onClick'> & {
  userId: number;
  as?: 'menu-item' | 'button';
  onToggleHide?: () => void;
  label?: string;
  unblockLabel?: string;
};
