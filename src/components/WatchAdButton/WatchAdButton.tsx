import { Button, ButtonProps } from '@mantine/core';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function WatchAdButton({ children, ...props }: Props) {
  const queryUtils = trpc.useUtils();
  const requestAdTokenMutation = trpc.user.requestAdToken.useMutation();
  const claimWatchedAdRewardMutation = trpc.buzz.claimWatchedAdReward.useMutation({
    onSuccess: async () => {
      await queryUtils.user.userRewardDetails.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to claim reward',
        error,
      });
    },
  });

  const handleLoadAd = async () => {
    try {
      const adToken = await requestAdTokenMutation.mutateAsync();

      window.pgHB = window.pgHB || { que: [] };
      window.pgHB.que.push(() => {
        try {
          window.pgHB?.requestWebRewardedAd?.({
            slotId: 'rewarded-ad',
            callback: (success: boolean) => {
              if (success) claimWatchedAdRewardMutation.mutate({ key: adToken });
            },
          });
        } catch (e) {
          // Handle uncaught errors
          console.error('BOOOM', e);
        }
      });
    } catch {
      showErrorNotification({
        title: 'Failed to load ad',
        error: new Error('Something went wrong, please try again later'),
      });
    }
  };

  return (
    <Button {...props} loading={requestAdTokenMutation.isLoading} onClick={handleLoadAd}>
      {children ? children : 'Watch an Ad'}
    </Button>
  );
}

type Props = Omit<ButtonProps, 'onClick'>;
