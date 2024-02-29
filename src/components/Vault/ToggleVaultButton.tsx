import React, { useCallback } from 'react';
import { useMutateVault } from '~/components/Vault/vault.util';
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
  const {
    data: isInVault = false,
    isLoading: isCheckingVault,
    isRefetching,
  } = trpc.vault.isModelVersionInVault.useQuery({
    modelVersionId,
  });

  const { toggleModelVersion, togglingModelVersion } = useMutateVault();
  const toggleVaultItem = useCallback(
    () => toggleModelVersion({ modelVersionId }),
    [toggleModelVersion, modelVersionId]
  );

  if (isCheckingVault) {
    return null;
  }

  return children({
    isInVault,
    isLoading: togglingModelVersion || isRefetching,
    toggleVaultItem,
  });
}
