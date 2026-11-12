import { page } from '$app/state';
import type { Tab } from './tabs';
import {
  TRANSCRIPT_AFTER,
  TRANSCRIPT_AROUND,
  TRANSCRIPT_BEFORE,
} from '$lib/chat-transcript-cursor';

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
    // `rpage: 1` is the canonical default and drops out of the URL. Scoped to that key on purpose —
    // dropping ANY param equal to 1 meant `chatUrl(1)` cleared the chat selection instead of opening
    // chat 1, and would silently do the same to the next numeric param added here.
    if (v === null || v === '' || (k === 'rpage' && v === 1)) next.delete(k);
    else next.set(k, String(v));
  }
  const path = `${BASE}/${tab ?? page.params.tab ?? 'chats'}`;
  const s = next.toString();
  return s ? `${path}?${s}` : path;
}

export const tabUrl = (tab: Tab) => urlWith({}, tab);

// Every tab shows the open chat beside its list, so opening one keeps the tab. The previous chat's
// page cursor belongs to that chat and does not carry over.
export const chatUrl = (chatId: number, around?: number) =>
  urlWith({
    chat: chatId,
    [TRANSCRIPT_BEFORE]: null,
    [TRANSCRIPT_AFTER]: null,
    [TRANSCRIPT_AROUND]: around ?? null,
  });

export const OPEN_ROW_CLASS = 'bg-dark-5 shadow-[inset_2px_0_0_var(--color-blue-5)]';
