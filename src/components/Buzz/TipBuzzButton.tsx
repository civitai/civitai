import { Button, ButtonProps, Group, useMantineTheme } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { openSendTipModal } from '../Modals/SendTipModal';
import { useTrackEvent } from '../TrackView/track.utils';

type Props = ButtonProps & {
  toUserId: number;
  entityId?: number;
  entityType?: string;
  label?: string;
};

export function TipBuzzButton({ toUserId, entityId, entityType, label, ...buttonProps }: Props) {
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();
  const features = useFeatureFlags();
  const theme = useMantineTheme();

  const { trackAction } = useTrackEvent();

  const handleClick = () => {
    openSendTipModal({ toUserId, entityId, entityType }, { fullScreen: isMobile });
    trackAction({ type: 'Tip_Click', details: { toUserId, entityId, entityType } }).catch(
      () => undefined
    );
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
        pr={label ? 12 : 8}
        onClick={handleClick}
        sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.accent[5] }}
        {...buttonProps}
      >
        <Group spacing={4} noWrap>
          <IconBolt size={14} fill="currentColor" />
          {label ?? 'Tip'}
        </Group>
      </Button>
    </LoginPopover>
  );
}
