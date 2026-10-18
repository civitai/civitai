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
 * What is in the chat's message box now; `''` before the chat has drawn it. Read from the box itself:
 * the chat's other fields (model search, settings, chat rename) fire `input` too, and the chat fills
 * and empties the box with no `input` at all.
 */
export function messageBoxText(chat: Pick<CivitaiChat, 'renderRoot'> | null): string {
  const draft = composer(chat)?.draft;
  return typeof draft === 'string' ? draft : '';
}

/**
 * Whether the user is dictating: the message box is hidden under the recording or transcribing bar,
 * and what they said goes into it when dictation ends, joined to whatever it holds by then.
 */
export function isDictating(chat: Pick<CivitaiChat, 'renderRoot'> | null): boolean {
  const box = composer(chat);
  return box?.recording === true || box?.transcribing === true;
}

function composer(chat: Pick<CivitaiChat, 'renderRoot'> | null) {
  return chat?.renderRoot?.querySelector('civitai-chat-composer') as {
    draft?: unknown;
    recording?: unknown;
    transcribing?: unknown;
  } | null;
}
