import { Indicator } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useChatEnabled } from '~/components/Chat/useChatEnabled';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '../LegacyActionIcon/LegacyActionIcon';

export function ChatButton() {
  const open = useChatStore((state) => state.open);
  const currentUser = useCurrentUser();
  const chatEnabled = useChatEnabled();

  const { data: unreadData, isLoading: unreadLoading } = trpc.chat.getUnreadCount.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  trpc.chat.getUserSettings.useQuery(undefined, { enabled: !!currentUser && chatEnabled });

  if (!currentUser || !chatEnabled) return <></>;

  const totalUnread = unreadData?.reduce((accum, { cnt }) => accum + cnt, 0) ?? 0;

  return (
    <>
      <Indicator
        color="red"
        disabled={unreadLoading || !totalUnread}
        // processing={unreadLoading} (this doesn't work)
        label={totalUnread > 99 ? '99+' : totalUnread}
        size={16}
        offset={4}
        className="flex items-center text-sm font-bold"
        classNames={{ indicator: 'cursor-pointer h-5' }}
        withBorder
      >
        <LegacyActionIcon
          variant={open ? 'filled' : 'subtle'}
          color="gray"
          onClick={() => useChatStore.setState((state) => ({ open: !state.open }))}
          data-testid="open-chat"
          aria-label="Chat"
        >
          <IconMessage2 />
        </LegacyActionIcon>
      </Indicator>
    </>
  );
}
