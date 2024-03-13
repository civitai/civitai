import React, { useCallback } from 'react';
import { useMutateVault } from '~/components/Vault/vault.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

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
  const {
    data: isInVault = false,
    isLoading: isCheckingVault,
    isRefetching,
  } = trpc.vault.isModelVersionInVault.useQuery(
    {
      modelVersionId,
    },
    {
      enabled: !!currentUser?.isMember,
    }
  );

  const { toggleModelVersion, togglingModelVersion } = useMutateVault();
  const toggleVaultItem = useCallback(
    () => toggleModelVersion({ modelVersionId }),
    [toggleModelVersion, modelVersionId]
  );

  if (!currentUser?.isMember || !features.vault) {
    return null;
  }

  return children({
    isInVault,
    isLoading: togglingModelVersion || isRefetching,
    toggleVaultItem,
  });
}
