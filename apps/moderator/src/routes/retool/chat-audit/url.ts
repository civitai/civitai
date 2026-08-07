import { page } from '$app/state';
import type { Tab } from './tabs';

const BASE = '/retool/chat-audit';

// Every link on this page must carry the params it isn't changing. A bare `?chat=` clears `q`, which
// resets the search box and unmounts the chat list — the moderator loses their results and their term
// mid-investigation, with only the Back button to recover.
//
// Tabs are sub-routes, so these produce a path as well as a query string; a query-only href would keep
// whichever tab the moderator is on and silently do nothing.
export function urlWith(params: Record<string, string | number | null>, tab?: Tab): string {
  const next = new URLSearchParams(page.url.searchParams);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === '' || v === 1) next.delete(k);
    else next.set(k, String(v));
  }
  const path = `${BASE}/${tab ?? page.params.tab ?? 'chats'}`;
  const s = next.toString();
  return s ? `${path}?${s}` : path;
}

export const tabUrl = (tab: Tab) => urlWith({}, tab);

// Opening a transcript has to move to the tab that renders transcripts, or the link sets `chat` and
// appears to do nothing.
export const chatUrl = (chatId: number) => urlWith({ chat: chatId }, 'chats');
