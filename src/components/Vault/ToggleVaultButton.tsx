import { Button, Modal, Stack, ThemeIcon, Text } from '@mantine/core';
import { IconCloudLock, IconServerBolt } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useCallback } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMutateVault } from '~/components/Vault/vault.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

const VaultUpsell = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const router = useRouter();

  return (
    <Modal {...dialog} title="Civitai Vault" size="sm" withCloseButton>
      <Stack align="center">
        <ThemeIcon size={100} radius={50} color="teal" variant="light">
          <IconCloudLock size={50} />
        </ThemeIcon>
        <Text weight={700} align="center">
          Try Civitai Vault
        </Text>
        <Text align="center" size="sm">
          Civitai Vault is your secure, cloud-based storage solution for your most cherished AI
          models.
        </Text>

        <Button
          onClick={() => {
            router.push('/pricing');
            handleClose();
          }}
          fullWidth
          radius="xl"
        >
          Become a Member
        </Button>
        <Button
          onClick={() => {
            router.push('/product/vault');
            handleClose();
          }}
          fullWidth
          color="gray"
          radius="xl"
        >
          Learn more about Vault
        </Button>
      </Stack>
    </Modal>
  );
};

const MembershipUpsell = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const router = useRouter();

  return (
    <Modal {...dialog} title="Whoops!" size="sm" withCloseButton>
      <Stack align="center">
        <ThemeIcon size={100} radius={50} color="teal" variant="light">
          <IconServerBolt size={50} />
        </ThemeIcon>
        <Text weight={700} align="center">
          Looks like you&rsquo;re running out of storage
        </Text>
        <Text align="center" size="sm">
          You can get more storage by upgrading to a higher Supporter tier, along with other great
          benefits!
        </Text>

        <Button
          onClick={() => {
            router.push('/pricing');
            handleClose();
          }}
          fullWidth
          radius="xl"
        >
          Upgrade my membership now
        </Button>
      </Stack>
    </Modal>
  );
};

export function ToggleVaultButton({
  modelVersionId,
  children,
}: {
  modelVersionId: number;
  children: (data: {
    isInVault: boolean;
    toggleVaultItem: () => void;
    isLoading: boolean;
  }) => React.ReactElement;
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data: isInVault = false, isRefetching } = trpc.vault.isModelVersionInVault.useQuery(
    {
      modelVersionId,
    },
    {
      enabled: !!currentUser?.isMember,
    }
  );

  const { toggleModelVersion, togglingModelVersion } = useMutateVault();
  const toggleVaultItem = useCallback(async () => {
    if (!currentUser?.isMember) {
      // Upsell:
      dialogStore.trigger({
        component: VaultUpsell,
      });

      return;
    }

    try {
      await toggleModelVersion({ modelVersionId });
    } catch (e: any) {
      // I hate this, but it's the only way to check for this error...
      // TRPC doesn't have a way to expand errors
      if (e.hasOwnProperty('message') && e?.message?.includes('Vault storage limit exceeded')) {
        dialogStore.trigger({
          component: MembershipUpsell,
        });
      }
    }
  }, [toggleModelVersion, modelVersionId]);

  if (!features.vault) {
    return null;
  }

  return children({
    isInVault,
    isLoading: togglingModelVersion || isRefetching,
    toggleVaultItem,
  });
}
