import { Button, ButtonProps, Group } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openBuyBuzzModal } from '../Modals/BuyBuzzModal';
import { openSendTipModal } from '../Modals/SendTipModal';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type Props = ButtonProps & { toUserId: number; iconSize?: number };

export function TipBuzzButton({ toUserId, iconSize, ...buttonProps }: Props) {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();
  const features = useFeatureFlags();

  const handleClick = () => {
    if (!currentUser?.balance)
      return openBuyBuzzModal({
        message:
          'You have insufficient funds to tip. You can buy more Buzz below to send a tip to your favorite creators.',
      });

    openSendTipModal({ toUserId }, { fullScreen: isMobile });
  };

  if (!features.buzz) return null;
  if (toUserId === currentUser?.id) return null;

  return (
    <LoginPopover>
      <Button
        variant="light"
        radius="xl"
        pl={5}
        onClick={handleClick}
        sx={(theme) => ({
          backgroundColor: theme.fn.rgba(theme.colors.dark[3], 0.06),
          color: theme.colors.accent[5],

          '&:hover': {
            backgroundColor: theme.fn.rgba(theme.colors.dark[3], 0.12),
          },
        })}
        {...buttonProps}
      >
        <Group spacing={4}>
          <IconBolt size={iconSize} fill="currentColor" />
          Tip Buzz
        </Group>
      </Button>
    </LoginPopover>
  );
}
