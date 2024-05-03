import { ChatMessageType } from '@prisma/client';
import produce from 'immer';
import { useCallback } from 'react';
import useSound from 'use-sound';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import { ChatAllMessages, ChatCreateChat } from '~/types/router';
import { trpc } from '~/utils/trpc';

const messageSound = '/sounds/message2.mp3'; // message

export const useChatNewMessageSignal = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [play] = useSound(messageSound, { volume: 0.5 });

  const onUpdate = useCallback(
    (updated: ChatAllMessages[number]) => {
      // queryUtils.chat.getInfiniteMessages.cancel();

      // - if chat is off or it's your message, ignore
      if (!currentUser || !features.chat || updated.userId === currentUser.id) return;

      // - add the message to the chat list at the end
      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId: updated.chatId },
        produce((old) => {
          if (!old) return old;

          const lastPage = old.pages[old.pages.length - 1];

          lastPage.items.push(updated);
        })
      );

      // - skip the rest for embeds
      if (updated.contentType === ChatMessageType.Embed) return;

      // - update the most recent message for preview (tk: skip image/video/audio when those are used)
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const thisChat = old.find((o) => o.id === updated.chatId);
          if (!thisChat) return old;
          // TODO I don't really know why, but updating the data like this does not cast dates automatically
          thisChat.messages = [
            {
              content: updated.content,
              contentType: updated.contentType,
              createdAt: new Date(updated.createdAt),
            },
          ];
        })
      );

      // - increment the unread message count
      queryUtils.chat.getUnreadCount.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const tChat = old.find((c) => c.chatId === updated.chatId);
          if (!tChat) {
            old.push({ chatId: updated.chatId, cnt: 1 });
          } else {
            tChat.cnt++;
          }
        })
      );

      // - play a sound
      const userSettings = queryUtils.chat.getUserSettings.getData();
      // this will play if no key is present (default not muted)
      if (userSettings?.muteSounds !== true) {
        // TODO maybe only play if window is open?
        play();
      }
    },
    [queryUtils, play, currentUser, currentUser?.id, features.chat]
  );

  useSignalConnection(SignalMessages.ChatNewMessage, onUpdate);
};

export const useChatNewRoomSignal = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [play] = useSound(messageSound, { volume: 0.5 });

  const onUpdate = useCallback(
    (updated: ChatCreateChat) => {
      if (!currentUser || !features.chat || updated.ownerId === currentUser.id) return;

      queryUtils.chat.getAllByUser.setData(undefined, (old) => {
        if (!old) return [updated];
        return [{ ...updated, createdAt: new Date(updated.createdAt) }, ...old];
      });

      queryUtils.chat.getUnreadCount.setData(
        undefined,
        produce((old) => {
          if (!old) return old;
          old.push({ chatId: updated.id, cnt: 1 });
        })
      );

      const userSettings = queryUtils.chat.getUserSettings.getData();
      if (userSettings?.muteSounds !== true) {
        play();
      }
    },
    [queryUtils, play, currentUser, features.chat]
  );

  useSignalConnection(SignalMessages.ChatNewRoom, onUpdate);
};
