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
  'teal',
  'dark-purple',
  'cyberpunk',
  'synthwave',
  'sci-fi',
  'pastels',
  'cream',
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

/**
 * Same local-only rule as TERMINAL_FONT, for the same reason: the app loads no
 * webfonts, so a display face has to already be on the machine. The Google name
 * leads each stack so these become real the day the app does load one; until
 * then the near-equivalents behind it — Windows and macOS system faces — are
 * what most readers actually get, and each stack ends on a generic that still
 * differs from the app's own face.
 */
const CYBER_FONT =
  "Rajdhani, 'Chakra Petch', Bahnschrift, 'DIN Alternate', 'Franklin Gothic Medium', 'Arial Narrow', sans-serif";
const SYNTH_FONT =
  "Audiowide, Michroma, Orbitron, 'Bahnschrift SemiBold', Impact, 'Haettenschweiler', sans-serif";
const SCIFI_FONT =
  "'Titillium Web', 'Chakra Petch', Bahnschrift, 'Avenir Next Condensed', 'Segoe UI', sans-serif";
const ROUNDED_FONT =
  "Nunito, Quicksand, 'Varela Round', 'SF Pro Rounded', 'Segoe UI Variable', 'Trebuchet MS', sans-serif";
const BOOK_FONT =
  "'EB Garamond', 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif";

/**
 * Grain as a tiled SVG filter rather than an image: it costs no asset request,
 * and it is the one texture that gradients cannot fake, because the point of it
 * is that the value never repeats on a period the eye can find.
 */
const grain = (opacity: number, frequency: number) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23g)' opacity='${opacity}'/%3E%3C/svg%3E")`;

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
  {
    slug: 'teal',
    name: 'Teal',
    free: false,
    swatch: ['#04151a', '#38d9a9'],
    vars: {
      '--chat-bg': '#04151a',
      '--chat-bg-image':
        'radial-gradient(125% 85% at 20% 0%, rgb(56 217 169 / 10%), transparent 68%)',
      '--chat-panel': '#082027',
      '--chat-panel-strong': '#0b2a33',
      '--chat-selected': '#0f3540',
      '--chat-line': '#154a56',
      '--chat-accent': '#38d9a9',
      '--chat-send': '#087f5b',
      '--chat-text': '#dcf5ee',
      '--chat-text-dim': '#a2ccc2',
      '--chat-meta': '#6f948c',
      '--chat-hover': 'rgb(56 217 169 / 9%)',
      '--chat-bubble': '#0a2830',
      '--chat-bubble-me': 'rgb(56 217 169 / 20%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '14px',
    },
  },
  {
    slug: 'dark-purple',
    name: 'Dark Purple',
    free: false,
    swatch: ['#0c0513', '#9d4edd'],
    vars: {
      '--chat-bg': '#0c0513',
      '--chat-bg-image':
        'radial-gradient(130% 80% at 50% 0%, rgb(157 78 221 / 14%), transparent 62%)',
      '--chat-panel': '#150920',
      '--chat-panel-strong': '#1d0d2c',
      '--chat-selected': '#251037',
      '--chat-line': '#3b1a55',
      '--chat-accent': '#9d4edd',
      '--chat-send': '#5f259f',
      '--chat-text': '#ead9f7',
      '--chat-text-dim': '#b795cf',
      '--chat-meta': '#8567a0',
      '--chat-hover': 'rgb(157 78 221 / 10%)',
      '--chat-bubble': '#1a0c28',
      '--chat-bubble-me': 'rgb(157 78 221 / 24%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '14px',
    },
  },
  {
    slug: 'cyberpunk',
    name: 'Cyberpunk',
    free: false,
    swatch: ['#05060f', '#ff4fd8'],
    vars: {
      '--chat-bg': '#05060f',
      // The static sits on top: it is what makes the neon read as a screen
      // rather than as a flat recolour.
      '--chat-bg-image': [
        grain(0.05, 0.9),
        'radial-gradient(90% 60% at 85% 0%, rgb(255 79 216 / 12%), transparent 60%)',
        'repeating-linear-gradient(90deg, rgb(34 211 238 / 6%) 0 1px, transparent 1px 46px)',
        'repeating-linear-gradient(0deg, rgb(34 211 238 / 6%) 0 1px, transparent 1px 46px)',
      ].join(', '),
      '--chat-panel': '#0a0c1a',
      '--chat-panel-strong': '#0f1224',
      '--chat-selected': '#16182e',
      '--chat-line': '#0f4a5c',
      '--chat-accent': '#ff4fd8',
      '--chat-send': '#0b7285',
      '--chat-text': '#d7e8f5',
      '--chat-text-dim': '#8fb3c9',
      '--chat-meta': '#5f7d92',
      '--chat-hover': 'rgb(34 211 238 / 10%)',
      '--chat-ui-font': CYBER_FONT,
      '--chat-radius': '2px',
      '--chat-bubble': '#101427',
      '--chat-bubble-me': 'rgb(255 79 216 / 18%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '2px',
    },
  },
  {
    slug: 'synthwave',
    name: 'Synthwave',
    free: false,
    swatch: ['#170a26', '#ff6ec7'],
    vars: {
      '--chat-bg': '#170a26',
      // First layer is the frontmost, so this is mist over grid over sunset.
      '--chat-bg-image': [
        'radial-gradient(80% 50% at 20% 20%, rgb(177 151 252 / 10%), transparent 70%)',
        'repeating-linear-gradient(0deg, rgb(255 110 199 / 9%) 0 1px, transparent 1px 22px)',
        'linear-gradient(0deg, rgb(255 138 61 / 22%) 0%, rgb(255 110 199 / 16%) 18%, transparent 45%)',
      ].join(', '),
      '--chat-panel': '#1f0e33',
      '--chat-panel-strong': '#2a1345',
      '--chat-selected': '#341a52',
      '--chat-line': '#4a2170',
      '--chat-accent': '#ff6ec7',
      '--chat-send': '#c2255c',
      '--chat-text': '#f6e6ff',
      '--chat-text-dim': '#c6a8e0',
      '--chat-meta': '#9078ad',
      '--chat-hover': 'rgb(255 110 199 / 10%)',
      '--chat-ui-font': SYNTH_FONT,
      '--chat-bubble': '#26123c',
      '--chat-bubble-me': 'rgb(255 110 199 / 22%)',
      '--chat-bubble-pad': '5px 10px',
      '--chat-bubble-radius': '12px',
    },
  },
  {
    slug: 'sci-fi',
    name: 'Sci-Fi',
    free: false,
    swatch: ['#040a15', '#ffb340'],
    vars: {
      '--chat-bg': '#040a15',
      // A third the contrast of the grid themes: the lattice shows through the
      // translucent panels below, and has to stay behind the text it lands on.
      '--chat-bg-image': [
        'radial-gradient(100% 55% at 50% 0%, rgb(56 189 248 / 9%), transparent 60%)',
        'repeating-linear-gradient(60deg, rgb(56 189 248 / 4%) 0 1px, transparent 1px 26px)',
        'repeating-linear-gradient(120deg, rgb(56 189 248 / 4%) 0 1px, transparent 1px 26px)',
      ].join(', '),
      '--chat-panel': '#0a1a2e',
      '--chat-panel-strong': '#0e2340',
      '--chat-selected': '#123050',
      '--chat-line': '#1c4a63',
      '--chat-accent': '#ffb340',
      '--chat-send': '#9a6207',
      '--chat-text': '#a8e4f0',
      '--chat-text-dim': '#79b3c4',
      '--chat-meta': '#5b8496',
      '--chat-hover': 'rgb(56 189 248 / 10%)',
      '--chat-ui-font': SCIFI_FONT,
      '--chat-msg-font': SCIFI_FONT,
      '--chat-radius': '3px',
      // Translucent so the lattice shows through the panel, which is what makes
      // it read as glass instead of as another flat fill.
      '--chat-bubble': 'rgb(13 42 66 / 72%)',
      '--chat-bubble-me': 'rgb(56 189 248 / 20%)',
      '--chat-bubble-pad': '6px 11px',
      '--chat-bubble-radius': '3px',
    },
  },
  {
    slug: 'pastels',
    name: 'Pastels',
    free: false,
    swatch: ['#f5f3fc', '#6f5bc4'],
    vars: {
      '--chat-bg': '#f5f3fc',
      '--chat-bg-image': [
        'radial-gradient(70% 50% at 0% 0%, rgb(177 151 252 / 22%), transparent 65%)',
        'radial-gradient(70% 50% at 100% 0%, rgb(247 131 172 / 18%), transparent 65%)',
        'radial-gradient(90% 55% at 50% 100%, rgb(99 217 194 / 18%), transparent 70%)',
      ].join(', '),
      '--chat-panel': '#eeeafa',
      '--chat-panel-strong': '#ffffff',
      '--chat-selected': '#e2dbf6',
      '--chat-line': '#d8d0ee',
      '--chat-accent': '#6f5bc4',
      '--chat-send': '#6f5bc4',
      '--chat-text': '#3b3357',
      '--chat-text-dim': '#615884',
      '--chat-meta': '#8d85a8',
      '--chat-hover': 'rgb(111 91 196 / 8%)',
      '--chat-ui-font': ROUNDED_FONT,
      '--chat-radius': '20px',
      '--chat-bubble': '#ffffff',
      '--chat-bubble-me': 'rgb(111 91 196 / 16%)',
      '--chat-bubble-pad': '6px 11px',
      '--chat-bubble-radius': '16px',
    },
  },
  {
    slug: 'cream',
    name: 'Cream',
    free: false,
    swatch: ['#f5ecd9', '#8a5a2b'],
    vars: {
      '--chat-bg': '#f5ecd9',
      '--chat-bg-image': [
        grain(0.045, 0.75),
        'radial-gradient(120% 90% at 50% 0%, rgb(122 82 48 / 6%), transparent 70%)',
      ].join(', '),
      '--chat-panel': '#efe4cd',
      '--chat-panel-strong': '#fbf5e8',
      '--chat-selected': '#e6d8bd',
      '--chat-line': '#ddcdae',
      '--chat-accent': '#8a5a2b',
      '--chat-send': '#7a4d22',
      '--chat-text': '#3f2f1e',
      '--chat-text-dim': '#5f4b33',
      '--chat-meta': '#8a7455',
      '--chat-hover': 'rgb(122 82 48 / 8%)',
      '--chat-ui-font': BOOK_FONT,
      '--chat-msg-font': BOOK_FONT,
      // A serif of the same nominal size reads smaller than the app's sans.
      '--chat-msg-size': '14.5px',
      '--chat-bubble': '#fbf5e8',
      '--chat-bubble-me': 'rgb(138 90 43 / 14%)',
      '--chat-bubble-pad': '6px 11px',
      '--chat-bubble-radius': '12px',
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
