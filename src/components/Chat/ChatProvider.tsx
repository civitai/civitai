import { create } from 'zustand';
// TODO - check for any selector type imports in client files
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

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
