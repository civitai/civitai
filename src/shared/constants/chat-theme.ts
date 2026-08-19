/**
 * Chat themes reskin the chat window for the person who picked one — the other
 * side of a conversation sees their own. Everything but the default is a
 * membership perk, granted as a `ChatTheme` cosmetic.
 *
 * The palettes live here rather than in the cosmetic's `data` so a cosmetic
 * record never becomes a channel for arbitrary CSS: the grant carries a slug,
 * and an unrecognized slug resolves to the default.
 */
export const CHAT_THEME_DEFAULT = 'default';

export const chatThemeSlugs = ['default', 'citron', 'bubblegum', 'terminal'] as const;
export type ChatThemeSlug = (typeof chatThemeSlugs)[number];

export type ChatTheme = {
  slug: ChatThemeSlug;
  name: string;
  /** Free for everyone; the rest need the matching cosmetic. */
  free: boolean;
  /** Rendered as the picker's swatch: window colour, then accent. */
  swatch: [string, string];
  /**
   * Null follows the app's own light/dark tokens. A named theme is a fixed
   * palette in both schemes — picking Terminal is picking the terminal look,
   * not a preference the color scheme gets to reinterpret.
   */
  vars: Record<string, string> | null;
};

export const chatThemes: ChatTheme[] = [
  {
    slug: 'default',
    name: 'Civitai',
    free: true,
    swatch: ['#12161d', '#4dabf7'],
    vars: null,
  },
  {
    slug: 'citron',
    name: 'Citron',
    free: false,
    swatch: ['#131006', '#f5c518'],
    vars: {
      '--chat-bg': '#131006',
      '--chat-bg-image':
        'radial-gradient(120% 80% at 50% 0%, rgb(245 197 24 / 7%), transparent 70%)',
      '--chat-panel': '#1a1507',
      '--chat-panel-strong': '#241d0b',
      '--chat-selected': '#2a2109',
      '--chat-line': '#3a2f0c',
      '--chat-accent': '#f5c518',
      '--chat-send': '#8f6a00',
      '--chat-text': '#f2ead4',
      '--chat-text-dim': '#c3b48a',
      '--chat-meta': '#8d8264',
      '--chat-hover': 'rgb(245 197 24 / 7%)',
      '--chat-bubble': '#211a09',
      '--chat-bubble-me': 'rgb(245 197 24 / 22%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '12px',
    },
  },
  {
    slug: 'bubblegum',
    name: 'Bubblegum',
    free: false,
    swatch: ['#170f14', '#f783ac'],
    vars: {
      '--chat-bg': '#170f14',
      '--chat-bg-image':
        'radial-gradient(120% 90% at 100% 0%, rgb(247 131 172 / 10%), transparent 65%)',
      '--chat-panel': '#1d1219',
      '--chat-panel-strong': '#291a24',
      '--chat-selected': '#33202c',
      '--chat-line': '#4a2338',
      '--chat-accent': '#f783ac',
      '--chat-send': '#d6336c',
      '--chat-text': '#f7e9f0',
      '--chat-text-dim': '#d3aebf',
      '--chat-meta': '#9c7d8c',
      '--chat-hover': 'rgb(247 131 172 / 8%)',
      '--chat-radius': '22px',
      '--chat-bubble': '#271722',
      '--chat-bubble-me': 'rgb(247 131 172 / 24%)',
      '--chat-bubble-pad': '6px 11px',
      '--chat-bubble-radius': '14px',
    },
  },
  {
    slug: 'terminal',
    name: 'Terminal',
    free: false,
    swatch: ['#0a0f0a', '#51cf66'],
    vars: {
      '--chat-bg': '#0a0f0a',
      '--chat-bg-image':
        'repeating-linear-gradient(0deg, rgb(105 219 124 / 3%) 0 1px, transparent 1px 3px)',
      '--chat-panel': '#0e150e',
      '--chat-panel-strong': '#14200f',
      '--chat-selected': '#16250f',
      '--chat-line': '#1e3a24',
      '--chat-accent': '#69db7c',
      '--chat-send': '#2b8a3e',
      '--chat-text': '#c9f2cf',
      '--chat-text-dim': '#8fbf98',
      '--chat-meta': '#6f8a75',
      '--chat-hover': 'rgb(105 219 124 / 8%)',
      '--chat-msg-font': 'var(--mantine-font-family-monospace)',
      '--chat-msg-size': '12.5px',
      '--chat-radius': '4px',
      '--chat-bubble': '#111c12',
      '--chat-bubble-me': 'rgb(105 219 124 / 20%)',
      '--chat-bubble-pad': '4px 9px',
      '--chat-bubble-radius': '3px',
    },
  },
];

const bySlug = new Map(chatThemes.map((t) => [t.slug, t]));

export function isChatThemeSlug(value: unknown): value is ChatThemeSlug {
  return typeof value === 'string' && bySlug.has(value as ChatThemeSlug);
}

/**
 * The theme actually rendered. Entitlement is resolved here, at render, rather
 * than by revoking a stored choice: a membership that lapses drops the window
 * back to the default on its own, and picks the theme back up if it returns.
 */
export function resolveChatTheme(slug: string | undefined, ownedSlugs: string[]): ChatTheme {
  const theme = isChatThemeSlug(slug) ? bySlug.get(slug) : undefined;
  if (!theme) return bySlug.get(CHAT_THEME_DEFAULT)!;
  return theme.free || ownedSlugs.includes(theme.slug) ? theme : bySlug.get(CHAT_THEME_DEFAULT)!;
}
