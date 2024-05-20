import { Card, Portal, createStyles } from '@mantine/core';
import {
  createContext,
  type Dispatch,
  ReactNode,
  type SetStateAction,
  useContext,
  useState,
} from 'react';
import { ChatWindow } from '~/components/Chat/ChatWindow';
import { useDialogStore } from '~/components/Dialog/dialogStore';
import { UserWithCosmetics } from '~/server/selectors/user.selector';
import { containerQuery } from '~/utils/mantine-css-helpers';

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

  return (
    <ChatContext.Provider value={{ state, setState }}>
      {children}
      <ChatPortal />
    </ChatContext.Provider>
  );
};

function ChatPortal() {
  const { classes } = useStyles();
  const { state } = useChatContext();
  const { dialogs } = useDialogStore();
  const main = typeof window !== 'undefined' ? document.querySelector('main') : null;
  const target = !main ? '#main' : dialogs.some((x) => x.target === '#main') ? '#main' : 'main';

  if (!state.open) return null;

  return (
    <Portal target={target}>
      <div className={classes.absolute}>
        <Card
          p={0}
          radius={4}
          withBorder
          shadow="md"
          sx={{
            width: '100%',
            height: '100%',
            overflow: 'hidden',
          }}
        >
          <ChatWindow />
        </Card>
      </div>
    </Portal>
  );
}

const useStyles = createStyles((theme) => ({
  absolute: {
    position: 'absolute',
    display: 'flex',
    bottom: theme.spacing.xs,
    left: theme.spacing.md,
    zIndex: 500,
    height: 'min(700px, 70%)',
    width: 'min(800px, 80%)',
    [containerQuery.smallerThan('sm')]: {
      height: `calc(100% - ${theme.spacing.xs * 2}px)`,
      width: `calc(100% - ${theme.spacing.md * 2}px)`,
    },
  },
}));
