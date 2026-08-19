import { Menu, Tooltip } from '@mantine/core';
import { IconBell, IconBellOff } from '@tabler/icons-react';
import React from 'react';
import {
  useCreatorAnnouncementsFeature,
  useIsCreatorMuted,
  useToggleAnnouncementMute,
} from '~/components/Announcements/creator-announcements.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

function useMuteControl(creatorId: number, muted: boolean) {
  const currentUser = useCurrentUser();
  const enabled = useCreatorAnnouncementsFeature();
  const { toggle, isLoading } = useToggleAnnouncementMute(creatorId);

  return {
    isLoading,
    handleToggle: () => toggle(!muted),
    visible: enabled && !!currentUser && currentUser.id !== creatorId,
  };
}

export function AnnouncementMuteToggle({ creatorId }: { creatorId: number }) {
  const muted = useIsCreatorMuted(creatorId);
  const { isLoading, handleToggle, visible } = useMuteControl(creatorId, muted);
  if (!visible) return null;

  const label = muted ? 'Unmute announcements' : 'Mute announcements';

  return (
    <Tooltip label={label} position="bottom">
      <LegacyActionIcon
        size={36}
        radius="xl"
        variant={muted ? 'filled' : 'light'}
        color="gray"
        loading={isLoading}
        onClick={handleToggle}
        aria-label={label}
      >
        {muted ? <IconBellOff size={16} /> : <IconBell size={16} />}
      </LegacyActionIcon>
    </Tooltip>
  );
}

export function AnnouncementMuteMenuItem({
  creatorId,
  creatorName,
  muted,
}: {
  creatorId: number;
  creatorName?: string | null;
  muted: boolean;
}) {
  const { handleToggle, visible } = useMuteControl(creatorId, muted);
  if (!visible) return null;

  const who = creatorName ? ` from ${creatorName}` : '';

  return (
    <Menu.Item
      leftSection={muted ? <IconBell size={14} /> : <IconBellOff size={14} />}
      onClick={handleToggle}
    >
      {muted ? `Unmute announcements${who}` : `Mute announcements${who}`}
    </Menu.Item>
  );
}
