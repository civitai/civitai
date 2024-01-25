import {
  createContext,
  type Dispatch,
  ReactNode,
  type SetStateAction,
  useContext,
  useState,
} from 'react';
import { UserWithCosmetics } from '~/server/selectors/user.selector';

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
