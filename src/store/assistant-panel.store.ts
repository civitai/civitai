import { create } from 'zustand';

/** Whether the CivBot chat is showing; shared so the support menu can open it. */
type State = { opened: boolean };

export const useAssistantPanelStore = create<State>(() => ({ opened: false }));
