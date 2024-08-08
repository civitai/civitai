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
  });

  const handleLoadAd = async () => {
    try {
      const adToken = await requestAdTokenMutation.mutateAsync();

      console.log('pushing to queue');
      window.pgHB = window.pgHB || { que: [] };
      window.pgHB.que.push(() => {
        try {
          console.log('requesting rewarded ad');
          window.pgHB?.requestWebRewardedAd?.({
            slotId: 'rewarded-ad',
            callback: (success: boolean) => {
              if (success) claimWatchedAdRewardMutation.mutate({ token: adToken });
            },
          });
        } catch (e) {
          // Handle uncaught errors
          console.log('BOOOM', e);
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
