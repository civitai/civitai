import { Button, ButtonProps, Group, useMantineColorScheme, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
// import { openSendTipModal } from '../Modals/SendTipModal';
import { useTrackEvent } from '../TrackView/track.utils';
import dynamic from 'next/dynamic';
import { dialogStore } from '~/components/Dialog/dialogStore';
const SendTipModal = dynamic(() => import('~/components/Modals/SendTipModal'));

type Props = ButtonProps & {
  toUserId: number;
  entityId?: number;
  entityType?: string;
  label?: string;
};

export function TipBuzzButton({ toUserId, entityId, entityType, label, ...buttonProps }: Props) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();

  const { trackAction } = useTrackEvent();

  const handleClick = () => {
    dialogStore.trigger({
      component: SendTipModal,
      props: {
        toUserId,
        entityId,
        entityType,
      },
    });
    // openSendTipModal({ toUserId, entityId, entityType }, { fullScreen: isMobile });
    trackAction({ type: 'Tip_Click', details: { toUserId, entityId, entityType } }).catch(
      () => undefined
    );
  };

  if (!features.buzz) return null;
  if (toUserId === currentUser?.id) return null;

  return (
    <LoginPopover>
      <Button
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        color="gray"
        radius="xl"
        pl={8}
        pr={label ? 12 : 8}
        onClick={handleClick}
        sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.accent[5] }}
        {...buttonProps}
      >
        <Group gap={4} wrap="nowrap">
          <IconBolt size={14} fill="currentColor" />
          {label ?? 'Tip'}
        </Group>
      </Button>
    </LoginPopover>
  );
}
