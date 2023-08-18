import { Button, ButtonProps, Group } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openBuyBuzzModal } from '../Modals/BuyBuzzModal';
import { openSendTipModal } from '../Modals/SendTipModal';

type Props = ButtonProps & { toUserId: number; iconSize?: number };

export function TipBuzzButton({ toUserId, iconSize, ...buttonProps }: Props) {
  const currentUser = useCurrentUser();

  const handleClick = () => {
    if (!currentUser?.balance)
      return openBuyBuzzModal({
        message:
          'You have insufficient funds to tip. You can buy more Buzz below to send a tip to your favorite creators.',
      });

    openSendTipModal({ toUserId });
  };

  if (toUserId === currentUser?.id) return null;

  return (
    <LoginPopover>
      <Button variant="outline" pl={5} onClick={handleClick} {...buttonProps}>
        <Group spacing={4}>
          <IconBolt size={iconSize} fill="currentColor" />
          Tip Buzz
        </Group>
      </Button>
    </LoginPopover>
  );
}
