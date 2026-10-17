import type { BeforeSendDetail, ChatChangeDetail } from '@civitai/components-chat/civitai-chat';

/** Calls `hold` before each message the chat sends; returning true keeps that message from going out. */
export function listenBeforeSend(el: HTMLElement, hold: (text: string) => boolean): () => void {
  const listener = (event: Event) => {
    if (hold((event as CustomEvent<BeforeSendDetail>).detail.text)) event.preventDefault();
  };
  el.addEventListener('before-send', listener);
  return () => el.removeEventListener('before-send', listener);
}

/** Calls `onChange` with the open chat's id whenever the viewer opens another chat. */
export function listenChatChange(
  el: HTMLElement,
  onChange: (chatId: string | null) => void
): () => void {
  const listener = (event: Event) =>
    onChange((event as CustomEvent<ChatChangeDetail>).detail.chatId);
  el.addEventListener('chat-change', listener);
  return () => el.removeEventListener('chat-change', listener);
}

const CHAT_APPS_LIMIT = 50;

/**
 * Which app each chat last worked on, kept in this browser. A new chat's id is announced before it is
 * saved, so entries for chats that never were are expected; the oldest go once there are too many.
 */
export function createChatAppStore(userKey: string) {
  const key = `app-assistant:chat-apps:${userKey}`;
  // Pairs, oldest first: an object would reorder ids that look like numbers.
  const read = (): [string, string][] => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      return Array.isArray(parsed)
        ? parsed.filter(
            (entry): entry is [string, string] =>
              Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string'
          )
        : [];
    } catch {
      return [];
    }
  };
  return {
    get(chatId: string): string | null {
      return read().find(([id]) => id === chatId)?.[1] ?? null;
    },
    set(chatId: string, app: string) {
      const entries = read();
      if (entries.some(([id, saved]) => id === chatId && saved === app)) return;
      const next = [...entries.filter(([id]) => id !== chatId), [chatId, app]].slice(
        -CHAT_APPS_LIMIT
      );
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked: the chat just won't reopen its app next time.
      }
    },
  };
}
