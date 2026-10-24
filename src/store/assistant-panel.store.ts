import { create } from 'zustand';

/**
 * Whether the CivBot chat is showing. Lifted out of `AssistantButton`'s local state
 * so the support menu can open it — the chat used to live inside the support modal,
 * and the menu that replaced it needs a way back to it.
 */
type State = { opened: boolean };

export const useAssistantPanelStore = create<State>(() => ({ opened: false }));
