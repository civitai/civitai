import produce from 'immer';
import { useCallback } from 'react';
import useSound from 'use-sound';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import { ChatMessageType, ChatNotifyLevel } from '~/shared/utils/prisma/enums';
import { reviveChatMessageDates, shouldNotifyForMessage } from '~/shared/utils/chat';
import type { ChatAllMessages, ChatCreateChat } from '~/types/router';
import { isApril1 } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const messageSound = isApril1() ? '/sounds/messageu.mp3' : '/sounds/message2.mp3';
const volume = isApril1() ? 0.2 : 0.5;

export const useChatNewMessageSignal = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [play] = useSound(messageSound, { volume });

  const onUpdate = useCallback(
    (updated: ChatAllMessages[number]) => {
      // queryUtils.chat.getInfiniteMessages.cancel();

      // - if chat is off or it's your message, ignore
      if (!currentUser || !features.chat || updated.userId === currentUser.id) return;

      const chats = queryUtils.chat.getAllByUser.getData();
      const thisChat = chats?.find((c) => c.id === updated.chatId);
      // A chat absent from the list is one this user deleted — the message that
      // just arrived is the first past their watermark, so refetch to bring it
      // back rather than dropping the signal.
      if (chats && !thisChat) {
        // The server may have re-armed this member into Requests, in which case
        // its unread count is 0 — refetch rather than incrementing below.
        queryUtils.chat.getAllByUser.invalidate();
        queryUtils.chat.getUnreadCount.invalidate();
        return;
      }

      const myMember = thisChat?.chatMembers.find((cm) => cm.userId === currentUser.id);
      const notify = shouldNotifyForMessage({
        level: myMember?.notifyLevel ?? ChatNotifyLevel.All,
        content: updated.content,
        username: currentUser.username,
      });

      // - add the message to the chat list at the end
      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId: updated.chatId },
        produce((old) => {
          if (!old) return old;

          // The backend returns messages grouped in chunks (pages).
          // `old.pages[0]` contains the newest chunk of messages, while older messages
          // are appended to the end of the array during infinite scrolling.
          // Therefore, new incoming messages must be appended to `pages[0]`.
          const newestPage = old.pages[0];
          newestPage.items.push(reviveChatMessageDates(updated));
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
          thisChat.messages = [
            {
              content: updated.content,
              contentType: updated.contentType,
              createdAt: new Date(updated.createdAt),
            },
          ];
        })
      );

      // - a conversation set to Nothing (or Mentions, unmentioned) still updates
      //   in place; it just does not announce itself
      if (!notify) return;

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
    [queryUtils, play, currentUser, features.chat]
  );

  useSignalConnection(SignalMessages.ChatNewMessage, onUpdate);
};

/**
 * A deleted message is hidden for everyone, so the other participant has to drop
 * it too — otherwise they keep rendering something that no longer exists.
 */
export const useChatMessageDeletedSignal = () => {
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    ({ messageId, chatId }: { messageId: number; chatId: number }) => {
      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId },
        produce((old) => {
          if (!old) return old;
          for (const page of old.pages) {
            const idx = page.items.findIndex((m) => m.id === messageId);
            if (idx !== -1) page.items.splice(idx, 1);
          }
        })
      );
      // The list preview may have been quoting the message that just went away.
      queryUtils.chat.getAllByUser.invalidate();
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.ChatMessageDeleted, onUpdate);
};

/**
 * A moderator edit rewrites content in place, so both participants keep
 * rendering the original until this patches their cache.
 */
export const useChatMessageUpdatedSignal = () => {
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    ({
      messageId,
      chatId,
      content,
      editedAt,
    }: {
      messageId: number;
      chatId: number;
      content: string;
      editedAt: string;
    }) => {
      queryUtils.chat.getInfiniteMessages.setInfiniteData(
        { chatId },
        produce((old) => {
          if (!old) return old;
          for (const page of old.pages) {
            const msg = page.items.find((m) => m.id === messageId);
            if (msg) {
              msg.content = content;
              msg.editedAt = new Date(editedAt);
            }
          }
        })
      );
      queryUtils.chat.getAllByUser.invalidate();
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.ChatMessageUpdated, onUpdate);
};

/**
 * A rename lands on everyone else's list, which otherwise keeps showing the old
 * title until something else refetches it.
 */
export const useChatRoomUpdatedSignal = () => {
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    ({ id, name }: { id: number; name: string | null }) => {
      queryUtils.chat.getAllByUser.setData(
        undefined,
        produce((old) => {
          const thisChat = old?.find((c) => c.id === id);
          if (!thisChat) return old;
          thisChat.name = name;
        })
      );
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.ChatRoomUpdated, onUpdate);
};

export const useChatNewRoomSignal = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [play] = useSound(messageSound, { volume });

  const onUpdate = useCallback(
    (updated: ChatCreateChat) => {
      if (!currentUser || !features.chat || updated.ownerId === currentUser.id) return;

      // A filtered request is deliberately absent from the server's unread count.
      // Incrementing it here anyway put it back in the header badge and rang the
      // sound — the exact thing the filter exists to prevent.
      const myMember = updated.chatMembers?.find((cm) => cm.userId === currentUser.id);
      if (myMember?.filteredAt) {
        queryUtils.chat.getAllByUser.invalidate();
        return;
      }

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
