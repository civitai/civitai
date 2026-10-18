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

/** Calls `onTyping` on each edit the user makes in the chat's message box. */
export function listenTyping(el: HTMLElement, onTyping: () => void): () => void {
  // Typing in the box is the only `input` the chat's own controls fire.
  el.addEventListener('input', onTyping);
  return () => el.removeEventListener('input', onTyping);
}
