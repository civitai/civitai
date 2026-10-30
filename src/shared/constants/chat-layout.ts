/**
 * How the message column is arranged. Independent of the theme, which is a
 * palette: either layout renders in any theme, and unlike a theme this is free
 * for everyone — it is a legibility preference, not a cosmetic.
 */
export const CHAT_LAYOUT_DEFAULT = 'stacked';

export const chatLayoutSlugs = ['stacked', 'bubbles'] as const;
export type ChatLayoutSlug = (typeof chatLayoutSlugs)[number];

export const chatLayouts: { slug: ChatLayoutSlug; name: string; description: string }[] = [
  {
    slug: 'stacked',
    name: 'Stacked',
    description: 'One column, newest at the bottom, sender shown once per run — like Discord.',
  },
  {
    slug: 'bubbles',
    name: 'Bubbles',
    description: 'Your messages on the right, everyone else on the left — like WhatsApp.',
  },
];

export function isChatLayoutSlug(value: unknown): value is ChatLayoutSlug {
  return chatLayoutSlugs.includes(value as ChatLayoutSlug);
}

export function resolveChatLayout(slug: string | undefined): ChatLayoutSlug {
  return isChatLayoutSlug(slug) ? slug : CHAT_LAYOUT_DEFAULT;
}
