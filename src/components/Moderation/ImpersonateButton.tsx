import { ActionIcon, Stack, Text, Tooltip } from '@mantine/core';
import { showNotification, updateNotification } from '@mantine/notifications';
import { IconCrystalBall, IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ImpersonateButton() {
  const currentUser = useCurrentUser();
  const { accounts, removeAccount, swapAccount, ogAccount, removeOgAccount } = useAccountContext();
  const [loading, setLoading] = useState<boolean>(false);

  const handleSwap = async () => {
    if (!currentUser || !ogAccount) return;
    setLoading(true);
    const notificationId = `impersonate-back`;

    showNotification({
      id: notificationId,
      loading: true,
      autoClose: false,
      title: 'Switching back...',
      message: `-> ${currentUser.username} (${currentUser.id})`,
    });

    const toAccount = Object.entries(accounts).find((a) => a[0] === ogAccount.id.toString());
    if (!toAccount) {
      setLoading(false);
      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to switch back',
        message: 'Could not find original account',
      });
      return;
    }

    removeAccount(currentUser.id);
    removeOgAccount();
    await swapAccount(toAccount[1].token);
  };

  if (!ogAccount || !currentUser || ogAccount.id === currentUser?.id) return <></>;

  return (
    <Tooltip
      label={
        <Stack spacing={0}>
          <Text>
            You are currently acting as {currentUser.username} ({currentUser.id}).
          </Text>
          <Text>Switch back to {ogAccount.username}.</Text>
        </Stack>
      }
      position="bottom"
    >
      <ActionIcon
        disabled={loading}
        color="red"
        variant="transparent"
        onClick={handleSwap}
        sx={{ boxShadow: '0 0 16px 2px red', borderRadius: '50%' }}
      >
        <IconCrystalBall />
      </ActionIcon>
    </Tooltip>
  );
}
