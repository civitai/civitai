import { create } from 'zustand';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

// Chat store state and actions
type ChatState = {
  open: boolean;
  isCreating: boolean;
  existingChatId: number | undefined;
  selectedUsers: Partial<UserWithCosmetics>[];
};

export const useChatStore = create<ChatState>(() => ({
  open: false,
  isCreating: false,
  existingChatId: undefined,
  selectedUsers: [],
}));
