import { ActionIcon, Stack, Text, Tooltip } from '@mantine/core';
import { showNotification, updateNotification } from '@mantine/notifications';
import { IconCrystalBall, IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function ImpersonateButton() {
  const currentUser = useCurrentUser();
  const { removeAccount, swapAccount, ogAccount, removeOgAccount } = useAccountContext();
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

    // Switch back to the moderator's own account by id (device-level switch — the hub re-mints their session).
    // STEP-F: impersonation moves to an `impersonatedBy` claim, dropping the ogAccount localStorage entirely.
    await removeAccount(currentUser.id);
    removeOgAccount();
    await swapAccount(ogAccount.id);
  };

  if (!ogAccount || !currentUser || ogAccount.id === currentUser?.id) return <></>;

  return (
    <Tooltip
      label={
        <Stack gap={0}>
          <Text>
            You are currently acting as {currentUser.username} ({currentUser.id}).
          </Text>
          <Text>Switch back to {ogAccount.username}.</Text>
        </Stack>
      }
      position="bottom"
    >
      <LegacyActionIcon
        disabled={loading}
        color="red"
        variant="transparent"
        onClick={handleSwap}
        style={{ boxShadow: '0 0 16px 2px red', borderRadius: '50%' }}
      >
        <IconCrystalBall />
      </LegacyActionIcon>
    </Tooltip>
  );
}
