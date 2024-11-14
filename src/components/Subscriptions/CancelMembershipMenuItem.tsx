import { Button, Image, Loader, Menu, Modal, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useMutatePaddle } from '~/components/Paddle/util';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useQueryVault, useQueryVaultItems } from '~/components/Vault/vault.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { usePaddle } from '~/providers/PaddleProvider';
import { showErrorNotification } from '~/utils/notifications';
import { formatKBytes } from '~/utils/number-helpers';

export function CancelMembershipMenuItem({ label = 'Cancel membership', icon }: Props) {
  const currentUser = useCurrentUser();

  const { paddle } = usePaddle();
  const { refreshSubscription } = useMutatePaddle();
  const { vault } = useQueryVault();
  const { subscription } = useActiveSubscription();

  const hasUsedVaultStorage = !!vault && vault.usedStorageKb > 0;

  const handleRefresh = async () => {
    try {
      await refreshSubscription();
      await currentUser?.refresh();
    } catch {
      // Reload page if refresh fails
      window.location.reload();
    }
  };

  return (
    <Menu.Item
      icon={icon}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!subscription) return;

        const result = await paddle.Retain.initCancellationFlow({
          subscriptionId: subscription.id,
        });

        if (result.status === 'error') {
          return showErrorNotification({
            title: 'Failed to cancel membership',
            error: new Error(
              'There was an error while trying to cancel your membership. Please try again later.'
            ),
          });
        }

        if (result.status === 'chose_to_cancel') {
          if (hasUsedVaultStorage) {
            dialogStore.trigger({
              component: VaultStorageDowngrade,
              props: {
                onContinue: handleRefresh,
              },
            });
          } else {
            await handleRefresh();
          }
        }
      }}
    >
      {label}
    </Menu.Item>
  );
}

type Props = {
  onFinish?: VoidFunction;
  label?: string;
  icon?: React.ReactNode;
};

export const VaultStorageDowngrade = () => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { vault, isLoading: vaultLoading } = useQueryVault();
  const { items, isLoading: loadingVaultItems, pagination } = useQueryVaultItems();
  const shownItems = items.filter((i) => !!i.coverImageUrl).slice(0, 3);

  return (
    <Modal {...dialog} size="md" title="Civitai Vault" radius="md">
      {vaultLoading || loadingVaultItems ? (
        <div className="flex items-center justify-center p-4">
          <Loader />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-4">
          <div className="flex flex-nowrap justify-center">
            {shownItems.map((item) => (
              <Image
                key={item.id}
                src={item.coverImageUrl}
                alt="Model Image"
                radius="lg"
                width={100}
                height={100}
              />
            ))}
          </div>
          <div className="flex flex-col gap-0">
            <Text align="center">
              You have{' '}
              <Text component="span" weight="bold">
                {formatKBytes(vault?.usedStorageKb ?? 0)}
              </Text>{' '}
              of storage used and{' '}
              <Text component="span" weight="bold">
                {pagination?.totalItems?.toLocaleString() ?? 0} models
              </Text>{' '}
              stored on your Vault. After downgrading, your Vault will be frozen.
            </Text>
            <Text color="dimmed" align="center">
              You will have a 7 day grace period to download models from your Vault.
            </Text>
          </div>
          <Link href="/user/vault" passHref>
            <Button component="a" onClick={handleClose} radius="xl">
              Go to my Vault
            </Button>
          </Link>
        </div>
      )}
    </Modal>
  );
};
