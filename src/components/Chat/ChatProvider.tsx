import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { create } from 'zustand';
import { AdUnitOutstreamWithCloseButton } from '~/components/Ads/AdUnitOutstream';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useIsClient } from '~/providers/IsClientProvider';
// TODO - check for any selector type imports in client files
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

const ChatWindow = dynamic(() => import('~/components/Chat/ChatWindow').then((m) => m.ChatWindow));

type ChatState = {
  open: boolean;
  isCreating: boolean;
  existingChatId: number | undefined;
  selectedUsers: Partial<UserWithCosmetics>[];
};

export const useChatStore = create<ChatState>(() => ({
  open: false,
  isCreating: false,
  existingChatId: undefined,
  selectedUsers: [],
}));

export function ChatPortal({ showFooter }: { showFooter: boolean }) {
  const open = useChatStore((state) => state.open);
  const isMobile = useIsMobile();
  const isClient = useIsClient();

  // if (!state.open) return null;

  if (!open)
    return isClient && !isMobile ? (
      <div className="absolute bottom-[var(--footer-height)] left-2 mb-2">
        <AdUnitOutstreamWithCloseButton />
      </div>
    ) : null;

  return (
    <div
      className={clsx(
        'absolute bottom-0 left-0 z-[251] mb-2 ml-2 h-dvh w-[calc(100%-1rem)]',
        '@sm:h-[800px] @sm:w-[70%] @sm:max-w-[700px]'
      )}
      style={{
        maxHeight: `calc(100dvh - var(--header-height)${
          showFooter ? ' - var(--footer-height)' : ''
        } - 1rem)`,
      }}
    >
      <ChatWindow />
    </div>
  );
}
