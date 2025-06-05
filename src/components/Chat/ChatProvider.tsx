import clsx from 'clsx';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { createContext, type Dispatch, type SetStateAction, useContext, useState } from 'react';
import { AdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
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

const ChatContext = createContext({
  state: {} as ChatState,
  setState: {} as Dispatch<SetStateAction<ChatState>>,
});

export const useChatContext = () => {
  const context = useContext(ChatContext);
  if (!context) throw new Error('ChatContext not in tree');
  return context;
};

export const ChatContextProvider = ({
  children,
  value = {
    open: false,
    isCreating: false,
    existingChatId: undefined,
    selectedUsers: [],
  } as ChatState,
}: {
  children: ReactNode;
  value?: ChatState;
}) => {
  const [state, setState] = useState(value);

  return <ChatContext.Provider value={{ state, setState }}>{children}</ChatContext.Provider>;
};

export function ChatPortal({ showFooter }: { showFooter: boolean }) {
  const { state } = useChatContext();
  const isMobile = useIsMobile();
  const isClient = useIsClient();

  // if (!state.open) return null;

  if (!state.open)
    return isClient && !isMobile ? (
      <div className="absolute bottom-[var(--footer-height)] left-2 mb-2">
        <AdUnitOutstream />
      </div>
    ) : null;

  return (
    <div
      className={clsx(
        'absolute left-0 z-10 mb-2 ml-2 h-dvh w-[calc(100%-1rem)] @sm:h-[800px] @sm:w-[70%] @sm:max-w-[700px]',
        showFooter ? 'bottom-[var(--footer-height)]' : 'bottom-0'
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
