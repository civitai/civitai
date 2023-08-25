import { Button, ButtonProps, Group, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { openBuyBuzzModal } from '../Modals/BuyBuzzModal';
import { openSendTipModal } from '../Modals/SendTipModal';

type Props = ButtonProps & { toUserId: number };

export function TipBuzzButton({ toUserId, ...buttonProps }: Props) {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();
  const features = useFeatureFlags();
  const theme = useMantineTheme();

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
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        color="gray"
        radius="xl"
        pl={8}
        pr={12}
        onClick={handleClick}
        sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.accent[5] }}
        {...buttonProps}
      >
        <Group spacing={4} noWrap>
          <IconBolt size={14} fill="currentColor" />
          Tip Buzz
        </Group>
      </Button>
    </LoginPopover>
  );
}
