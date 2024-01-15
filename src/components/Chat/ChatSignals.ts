import produce from 'immer';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { ChatAllMessages, ChatCreateChat } from '~/types/router';
import { trpc } from '~/utils/trpc';

export const useChatNewMessageSignal = () => {
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    (updated: ChatAllMessages[number]) => {
      // queryUtils.chat.getInfiniteMessages.cancel();

      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId: updated.chatId },
        produce((old) => {
          if (!old) {
            return {
              pages: [],
              pageParams: [],
            };
          }

          const lastPage = old.pages[old.pages.length - 1];

          lastPage.items.push(updated);
        })
      );

      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const thisChat = old.find((o) => o.id === updated.chatId);
          if (!thisChat) return old;
          thisChat.messages = [{ content: updated.content, contentType: updated.contentType }];
        })
      );
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.ChatNewMessage, onUpdate);
};

export const useChatNewRoomSignal = () => {
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    (updated: ChatCreateChat) => {
      queryUtils.chat.getAllByUser.setData(undefined, (old) => {
        // proper typing would be nice but typescript is being cranky
        if (!old) return [updated] as any;
        return [updated, ...old];
      });
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.ChatNewRoom, onUpdate);
};
