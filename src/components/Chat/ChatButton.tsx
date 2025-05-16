import { ActionIcon, Indicator } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useChatContext } from '~/components/Chat/ChatProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export function ChatButton() {
  const { state, setState } = useChatContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const { data: unreadData, isLoading: unreadLoading } = trpc.chat.getUnreadCount.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  trpc.chat.getUserSettings.useQuery(undefined, { enabled: !!currentUser });

  if (!currentUser || !features.chat) return <></>;

  const totalUnread = unreadData?.reduce((accum, { cnt }) => accum + cnt, 0);

  return (
    <>
      <Indicator
        color="red"
        disabled={unreadLoading || !totalUnread}
        // processing={unreadLoading} (this doesn't work)
        label={totalUnread}
        size={16}
        offset={4}
        className="flex items-center"
        styles={{
          indicator: {
            height: '20px !important',
            '> span': { marginBottom: '2px' },
          },
        }}
        withBorder
        inline
      >
        <ActionIcon
          variant={state.open ? 'filled' : 'subtle'}
          color="gray"
          onClick={() => setState((prev) => ({ ...prev, open: !state.open }))}
          data-testid="open-chat"
        >
          <IconMessage2 />
        </ActionIcon>
      </Indicator>
    </>
  );
}
