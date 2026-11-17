// Separate from url.ts because the server load validates the `tab` param and url.ts reaches for
// `$app/state`, which must not be pulled into the server bundle.
export const TABS = ['chats', 'reports', 'stats', 'newest'] as const;
export type Tab = (typeof TABS)[number];

/** The search tab keeps the slug `chats`: `entity-url.ts` links to it. */
export const TAB_LABELS: Record<Tab, string> = {
  chats: 'Search',
  reports: 'Reports',
  stats: 'Stats',
  newest: 'Newest',
};
