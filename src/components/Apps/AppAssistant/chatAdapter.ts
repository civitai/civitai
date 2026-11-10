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
 * (`saved`); that is no change of chat, so it is not passed on (it would close a Submit for review offer).
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
