import { create } from 'zustand';
// TODO - check for any selector type imports in client files
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

export type ChatSettingsScope = 'global' | 'conversation';

type ChatState = {
  open: boolean;
  isCreating: boolean;
  isSettingsOpen: boolean;
  settingsScope: ChatSettingsScope;
  existingChatId: number | undefined;
  selectedUsers: Partial<UserWithCosmetics>[];
};

export const useChatStore = create<ChatState>(() => ({
  open: false,
  isCreating: false,
  isSettingsOpen: false,
  settingsScope: 'global',
  existingChatId: undefined,
  selectedUsers: [],
}));
