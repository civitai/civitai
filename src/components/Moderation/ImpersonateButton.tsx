import { ActionIcon, Stack, Text, Tooltip } from '@mantine/core';
import { IconCrystalBall } from '@tabler/icons-react';
import { useState } from 'react';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';

export function ImpersonateButton() {
  const currentUser = useCurrentUser();
  const { accounts, removeAccount, swapAccount, ogAccount, removeOgAccount } = useAccountContext();
  const [loading, setLoading] = useState<boolean>(false);

  const handleSwap = async () => {
    if (!currentUser || !ogAccount) return;
    setLoading(true);
    const toAccount = Object.entries(accounts).find((a) => a[0] === ogAccount.id.toString());
    if (!toAccount) {
      setLoading(false);
      showErrorNotification({
        title: 'Failed to switch back',
        error: new Error('Could not find original account'),
      });
      return;
    }

    removeAccount(currentUser.id);
    removeOgAccount();
    await swapAccount(toAccount[1].token);
    setLoading(false);
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
      <ActionIcon disabled={loading} color="red" variant="transparent" onClick={handleSwap}>
        <IconCrystalBall />
      </ActionIcon>
    </Tooltip>
  );
}
