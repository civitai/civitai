import { describe, expect, it, vi } from 'vitest';
import { listenChatChange } from '~/components/Apps/AppAssistant/chatAdapter';

const change = (chatId: string | null, saved: boolean) =>
  new CustomEvent('chat-change', { detail: { chatId, saved } });

describe('listenChatChange on components-chat 0.22', () => {
  it('passes on a change of chat, but not the same chat announced again once its first save lands', () => {
    const el = new EventTarget();
    const onChange = vi.fn();
    listenChatChange(el, onChange);
    el.dispatchEvent(change('chat-1', false));
    // 0.22: the same chat again, now saved. No chat change: a Submit for review offer must survive it.
    el.dispatchEvent(change('chat-1', true));
    el.dispatchEvent(change('chat-2', false));
    el.dispatchEvent(change(null, false));
    expect(onChange.mock.calls).toEqual([['chat-1'], ['chat-2'], [null]]);
  });

  it('starts from the chat already open, so its own announcement is not a change', () => {
    const el = new EventTarget();
    const onChange = vi.fn();
    listenChatChange(el, onChange, 'chat-1');
    el.dispatchEvent(change('chat-1', true));
    expect(onChange).not.toHaveBeenCalled();
    // Control: another chat still is.
    el.dispatchEvent(change('chat-2', false));
    expect(onChange).toHaveBeenCalledWith('chat-2');
  });
});
