/**
 * Chat themes reskin the chat window for the person who picked one — the other
 * side of a conversation sees their own. Everything but the default comes with
 * a membership, for as long as the membership lasts.
 */
export const CHAT_THEME_DEFAULT = 'default';

export const chatThemeSlugs = [
  'default',
  'citron',
  'bubblegum',
  'terminal',
  'orange',
  'blue',
  'violet',
] as const;
export type ChatThemeSlug = (typeof chatThemeSlugs)[number];

export type ChatTheme = {
  slug: ChatThemeSlug;
  name: string;
  /** Free for everyone; the rest need an active membership. */
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

/**
 * Named rather than `--mantine-font-family-monospace`, whose stack leads with
 * `ui-monospace`/`SFMono-Regular` — the system UI mono, which reads as the app's
 * own face on a Mac and defeats the point of the skin. Locally installed faces
 * only, so the theme costs no webfont: the open-licensed ones are preferred and
 * the platform monos are the floor.
 */
const TERMINAL_FONT =
  "'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', Consolas, 'Liberation Mono', 'Courier New', monospace";

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
      '--chat-ui-font': TERMINAL_FONT,
      '--chat-msg-font': TERMINAL_FONT,
      '--chat-msg-size': '12.5px',
      '--chat-radius': '4px',
      '--chat-bubble': '#111c12',
      '--chat-bubble-me': 'rgb(105 219 124 / 20%)',
      '--chat-bubble-pad': '4px 9px',
      '--chat-bubble-radius': '3px',
    },
  },
  {
    slug: 'orange',
    name: 'Orange',
    free: false,
    swatch: ['#160f08', '#ff922b'],
    vars: {
      '--chat-bg': '#160f08',
      '--chat-bg-image':
        'radial-gradient(120% 85% at 50% 0%, rgb(255 146 43 / 9%), transparent 70%)',
      '--chat-panel': '#1e150c',
      '--chat-panel-strong': '#2a1d0f',
      '--chat-selected': '#332211',
      '--chat-line': '#4d3216',
      '--chat-accent': '#ff922b',
      '--chat-send': '#e8590c',
      '--chat-text': '#f7ead9',
      '--chat-text-dim': '#d2b393',
      '--chat-meta': '#9a8069',
      '--chat-hover': 'rgb(255 146 43 / 8%)',
      '--chat-bubble': '#261a0e',
      '--chat-bubble-me': 'rgb(255 146 43 / 22%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '12px',
    },
  },
  {
    slug: 'blue',
    name: 'Blue',
    free: false,
    swatch: ['#061225', '#74c0fc'],
    vars: {
      '--chat-bg': '#061225',
      '--chat-bg-image':
        'radial-gradient(130% 90% at 0% 0%, rgb(116 192 252 / 10%), transparent 65%)',
      '--chat-panel': '#0b1930',
      '--chat-panel-strong': '#11233f',
      '--chat-selected': '#152c4d',
      '--chat-line': '#1e3d68',
      '--chat-accent': '#74c0fc',
      '--chat-send': '#1c7ed6',
      '--chat-text': '#e2eefb',
      '--chat-text-dim': '#a9c4e0',
      '--chat-meta': '#7391b0',
      '--chat-hover': 'rgb(116 192 252 / 9%)',
      '--chat-bubble': '#0f2340',
      '--chat-bubble-me': 'rgb(116 192 252 / 22%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '14px',
    },
  },
  {
    slug: 'violet',
    name: 'Violet',
    free: false,
    swatch: ['#100c1c', '#b197fc'],
    vars: {
      '--chat-bg': '#100c1c',
      '--chat-bg-image':
        'radial-gradient(125% 85% at 50% 100%, rgb(177 151 252 / 10%), transparent 70%)',
      '--chat-panel': '#171126',
      '--chat-panel-strong': '#201733',
      '--chat-selected': '#281c3e',
      '--chat-line': '#3a2a5c',
      '--chat-accent': '#b197fc',
      '--chat-send': '#6741d9',
      '--chat-text': '#ece5fb',
      '--chat-text-dim': '#bfaee0',
      '--chat-meta': '#8b7bab',
      '--chat-hover': 'rgb(177 151 252 / 9%)',
      '--chat-bubble': '#1c1430',
      '--chat-bubble-me': 'rgb(177 151 252 / 22%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '14px',
    },
  },
];

const bySlug = new Map(chatThemes.map((t) => [t.slug, t]));

export function isChatThemeSlug(value: unknown): value is ChatThemeSlug {
  return typeof value === 'string' && bySlug.has(value as ChatThemeSlug);
}

/**
 * The theme actually rendered. Entitlement is resolved here, at render, rather
 * than by rewriting a stored choice when a membership lapses: the window drops
 * back to the default on its own, and picks the theme back up on renewal
 * without the member having to set it again.
 */
export function resolveChatTheme(slug: string | undefined, isMember: boolean): ChatTheme {
  const theme = isChatThemeSlug(slug) ? bySlug.get(slug) : undefined;
  if (!theme) return bySlug.get(CHAT_THEME_DEFAULT)!;
  return theme.free || isMember ? theme : bySlug.get(CHAT_THEME_DEFAULT)!;
}
