// Retool's tabbedContainer1, in its order. Separate from url.ts because the server load validates the
// `tab` param and url.ts reaches for `$app/state`, which must not be pulled into the server bundle.
export const TABS = ['chats', 'reports', 'stats', 'newest'] as const;
export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  chats: 'Chats',
  reports: 'Chat Reports',
  stats: 'Stats',
  newest: 'Newest',
};
