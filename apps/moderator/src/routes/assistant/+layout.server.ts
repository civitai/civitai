import type { LayoutServerLoad } from './$types';
import { listChats, type Chat } from '$lib/server/assistant/store';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { assistantStoreMessage } from './store-status';

// The moderator's own chat list, kept by the layout so it survives moving between chats. Chats are
// private: nothing here or below lists another moderator's (the audit page is the one exception, and
// it is its own grant).
export const load: LayoutServerLoad = async ({ locals }) => {
  let chats: Chat[] = [];
  let storeError: string | null = null;
  try {
    chats = await listChats(locals.user.id);
  } catch (e) {
    console.error('[assistant] chat list unavailable', e);
    storeError = assistantStoreMessage(moderatorDbStatus(e));
  }
  return { chats, storeError, wide: true };
};
