import { Button, Modal, Stack, ThemeIcon, Text } from '@mantine/core';
import { IconCloudLock } from '@tabler/icons-react';
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
  const toggleVaultItem = useCallback(() => {
    if (!currentUser?.isMember) {
      // Upsell:
      dialogStore.trigger({
        component: VaultUpsell,
      });

      return;
    }

    toggleModelVersion({ modelVersionId });
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
