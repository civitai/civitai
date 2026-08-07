import { page } from '$app/state';
import type { Tab } from './tabs';

// Every link on this page must carry the params it isn't changing. A bare `?chat=` clears `q`, which
// resets the search box and unmounts the chat list — the moderator loses their results and their term
// mid-investigation, with only the Back button to recover.
export function urlWith(params: Record<string, string | number | null>): string {
  const next = new URLSearchParams(page.url.searchParams);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === '' || v === 1) next.delete(k);
    else next.set(k, String(v));
  }
  const s = next.toString();
  return s ? `?${s}` : '?';
}

// Tab lives in the URL rather than local state so a moderator can link a colleague to the tab they are
// looking at, and so Back steps through an investigation.
export const tabUrl = (tab: Tab) => urlWith({ tab });

// Opening a transcript from the report queue has to move to the tab that renders transcripts, or the
// link sets `chat` and appears to do nothing.
export const chatUrl = (chatId: number) => urlWith({ chat: chatId, tab: 'chats' });
