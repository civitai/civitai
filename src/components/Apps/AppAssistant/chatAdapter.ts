import type {
  BeforeSendDetail,
  ChatChangeDetail,
  CivitaiChat,
} from '@civitai/components-chat/civitai-chat';

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

/**
 * What is in the chat's message box now, from the chat's `draft`: what the user typed, or what
 * `compose()` put there; `''` with no chat, or before the chat has drawn its box. Read on demand: the
 * chat fills and empties the box with no `input` event, and its other fields fire `input` too.
 */
export function messageBoxText(chat: Pick<CivitaiChat, 'draft'> | null): string {
  return chat?.draft ?? '';
}

/**
 * Whether the user is dictating, from the chat's `dictating`: true from the moment they start talking
 * until what they said has been joined to the end of `draft` (or sent, or thrown away), including the
 * moment between recording and transcribing. Meanwhile `draft` is what the box held before. `false`
 * with no chat.
 */
export function isDictating(chat: Pick<CivitaiChat, 'dictating'> | null): boolean {
  return chat?.dictating === true;
}
