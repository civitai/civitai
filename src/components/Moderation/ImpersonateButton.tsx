import { Stack, Text, Tooltip } from '@mantine/core';
import { showNotification, updateNotification } from '@mantine/notifications';
import { IconCrystalBall, IconX } from '@tabler/icons-react';
import { useSession } from 'next-auth/react';
import React, { useState } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

// Shown only while impersonating (section F). "Am I impersonating?" comes straight from the session's
// `impersonatedBy` claim — no localStorage ogAccount. Exiting goes through the account context (which hits the
// hub via the same-origin proxy), reads the claim server-side, and re-mints the moderator's own session.
export function ImpersonateButton() {
  const currentUser = useCurrentUser();
  const { data: session } = useSession();
  const { exitImpersonation } = useAccountContext();
  const impersonatedBy = session?.impersonatedBy;
  const [loading, setLoading] = useState(false);

  const handleExit = async () => {
    setLoading(true);
    const notificationId = 'impersonate-back';
    showNotification({
      id: notificationId,
      loading: true,
      autoClose: false,
      title: 'Switching back...',
      message: 'Returning to your account',
    });

    try {
      await exitImpersonation(); // reloads as the moderator on success
    } catch {
      setLoading(false);
      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to switch back',
        message: 'Could not exit impersonation',
      });
    }
  };

  if (!impersonatedBy || !currentUser) return <></>;

  return (
    <Tooltip
      label={
        <Stack gap={0}>
          <Text>
            You are acting as {currentUser.username} ({currentUser.id}).
          </Text>
          <Text>Click to return to your account.</Text>
        </Stack>
      }
      position="bottom"
    >
      <LegacyActionIcon
        disabled={loading}
        color="red"
        variant="transparent"
        onClick={handleExit}
        style={{ boxShadow: '0 0 16px 2px red', borderRadius: '50%' }}
      >
        <IconCrystalBall />
      </LegacyActionIcon>
    </Tooltip>
  );
}
