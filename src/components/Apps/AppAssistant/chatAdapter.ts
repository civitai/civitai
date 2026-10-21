import type {
  BeforeSendDetail,
  ChatChangeDetail,
  CivitaiChat,
  ReplyResumeDetail,
} from '@civitai/components-chat/civitai-chat';

/**
 * Calls `hold` before each message the chat sends, with the message and its `queue()`: calling
 * `queue()` (there and then, not later) keeps the message waiting, shown in the chat, until released.
 */
export function listenBeforeSend(
  el: HTMLElement,
  hold: (text: string, queue: BeforeSendDetail['queue']) => void
): () => void {
  const listener = (event: Event) => {
    const { text, queue } = (event as CustomEvent<BeforeSendDetail>).detail;
    hold(text, queue);
  };
  el.addEventListener('before-send', listener);
  return () => el.removeEventListener('before-send', listener);
}

/**
 * Calls `hold` before the chat asks again for a failed reply (Retry, or by itself as the page wakes or
 * comes back online), which fires no `before-send`; returning true keeps it from asking. The page then
 * asks with `chat.retryReply()` once it is ready.
 */
export function listenReplyResume(
  el: HTMLElement,
  hold: (trigger: ReplyResumeDetail['trigger']) => boolean
): () => void {
  const listener = (event: Event) => {
    if (hold((event as CustomEvent<ReplyResumeDetail>).detail.trigger)) event.preventDefault();
  };
  el.addEventListener('reply-resume', listener);
  return () => el.removeEventListener('reply-resume', listener);
}

/**
 * Calls `onChange` with the open chat's id whenever the viewer opens another chat. Since
 * components-chat 0.22, `chat-change` also fires for the same chat once its first save lands
 * (`saved`); that is no change of chat, so it is not passed on (it would take Build it away).
 * `current`: the chat already open as this starts listening.
 */
export function listenChatChange(
  el: EventTarget,
  onChange: (chatId: string | null) => void,
  current?: string | null
): () => void {
  let last = current;
  const listener = (event: Event) => {
    const { chatId } = (event as CustomEvent<ChatChangeDetail>).detail;
    if (chatId === last) return;
    last = chatId;
    onChange(chatId);
  };
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
