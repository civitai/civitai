// Third-party embeds for the rich text editor. Shared by the editor (detect + insert), the
// tiptap node (render), the sanitizer (save + render) and the Bandcamp lookup (server).
//
// Every host check compares `URL.hostname` for equality. `endsWith`/`includes` on a host lets
// `evilvimeo.com` or `vimeo.com.evil.test` through; the only suffix rules are anchored
// single-label regexes (`<label>.bandcamp.com`, `<label>.hf.space`).

export const EMBED_PROVIDERS = [
  'bandcamp',
  'soundcloud',
  'spotify',
  'vimeo',
  'twitch',
  'huggingface',
] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

/** The pre-existing embeds, which keep their own tiptap nodes. */
export type LegacyEmbedKind = 'youtube' | 'instagram' | 'strawpoll';

export type ParsedEmbed =
  | { kind: 'embed'; provider: EmbedProvider; playerUrl: string }
  | { kind: 'bandcamp-lookup'; pageUrl: string }
  | { kind: LegacyEmbedKind; url: string };

export const EMBED_PROVIDER_LABELS: Record<EmbedProvider | LegacyEmbedKind, string> = {
  bandcamp: 'Bandcamp',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  vimeo: 'Vimeo',
  twitch: 'Twitch',
  huggingface: 'Hugging Face Space',
  youtube: 'YouTube',
  instagram: 'Instagram',
  strawpoll: 'StrawPoll',
};

/** Hosts of the player iframes, exactly. hf.space subdomains are matched by HF_SPACE_HOST. */
export const EMBED_PLAYER_HOSTS = [
  'bandcamp.com',
  'w.soundcloud.com',
  'open.spotify.com',
  'player.vimeo.com',
  'player.twitch.tv',
  'clips.twitch.tv',
] as const;

const BANDCAMP_PAGE_HOST = /^(?:[a-z0-9-]+\.)?bandcamp\.com$/;
const HF_SPACE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.hf\.space$/;

function parseUrl(input: string, { allowHttp }: { allowHttp: boolean }): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return null;
  // `https://vimeo.com@evil.test/1` has hostname evil.test, but refuse userinfo outright so a
  // reader of the stored URL is never misled either.
  if (url.username || url.password || url.port) return null;
  return url;
}

const oneOf = (host: string, hosts: readonly string[]) => hosts.includes(host);

// ---------------------------------------------------------------------------------------------
// Page URL -> player URL
// ---------------------------------------------------------------------------------------------

const TWITCH_RESERVED = new Set([
  'directory',
  'downloads',
  'jobs',
  'login',
  'p',
  'search',
  'settings',
  'signup',
  'turbo',
  'videos',
  'wallet',
]);

function parseBandcampPage(url: URL): ParsedEmbed | null {
  if (!BANDCAMP_PAGE_HOST.test(url.hostname)) return null;
  if (!/^\/(?:track|album)\/[a-z0-9-]+\/?$/i.test(url.pathname)) return null;
  return { kind: 'bandcamp-lookup', pageUrl: `https://${url.hostname}${url.pathname}` };
}

// Bandcamp's own embed code. Needs no lookup, so it still works when the page fetch is refused.
function parseBandcampPlayer(url: URL): ParsedEmbed | null {
  if (url.hostname !== 'bandcamp.com' || url.protocol !== 'https:') return null;
  if (!isAllowedPlayerUrl(url.toString())) return null;
  const match = /^\/EmbeddedPlayer\/(?:v=2\/)?(track|album)=(\d+)/.exec(url.pathname);
  if (!match) return null;
  return {
    kind: 'embed',
    provider: 'bandcamp',
    playerUrl: bandcampPlayerUrl(match[1] as 'track' | 'album', match[2]),
  };
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseSoundcloud(url: URL): ParsedEmbed | null {
  if (!oneOf(url.hostname, ['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']))
    return null;
  const path = url.pathname.replace(/\/$/, '');
  if (!/^\/[\w-]+\/(?:sets\/)?[\w-]+$/.test(path)) return null;
  const canonical = `https://soundcloud.com${path}`;
  return {
    kind: 'embed',
    provider: 'soundcloud',
    playerUrl: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonical)}`,
  };
}

const SPOTIFY_PATH =
  /^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{22})\/?$/i;

function parseSpotify(url: URL): ParsedEmbed | null {
  if (url.hostname !== 'open.spotify.com') return null;
  const match = SPOTIFY_PATH.exec(url.pathname);
  if (!match) return null;
  return {
    kind: 'embed',
    provider: 'spotify',
    playerUrl: `https://open.spotify.com/embed/${match[1].toLowerCase()}/${match[2]}`,
  };
}

function vimeoPlayer(id: string, hash: string | null | undefined): ParsedEmbed {
  const h = hash && /^[0-9a-f]+$/i.test(hash) ? `?h=${hash}` : '';
  return {
    kind: 'embed',
    provider: 'vimeo',
    playerUrl: `https://player.vimeo.com/video/${id}${h}`,
  };
}

function parseVimeo(url: URL): ParsedEmbed | null {
  if (url.hostname === 'player.vimeo.com') {
    const match = /^\/video\/(\d+)\/?$/.exec(url.pathname);
    return match ? vimeoPlayer(match[1], url.searchParams.get('h')) : null;
  }
  if (!oneOf(url.hostname, ['vimeo.com', 'www.vimeo.com'])) return null;
  const match = /^\/(?:channels\/[\w-]+\/)?(\d+)(?:\/([0-9a-f]+))?\/?$/i.exec(url.pathname);
  return match ? vimeoPlayer(match[1], match[2] ?? url.searchParams.get('h')) : null;
}

function parseTwitch(url: URL): ParsedEmbed | null {
  const clip = (slug: string): ParsedEmbed => ({
    kind: 'embed',
    provider: 'twitch',
    playerUrl: `https://clips.twitch.tv/embed?clip=${slug}`,
  });
  if (url.hostname === 'clips.twitch.tv') {
    const match = /^\/([\w-]+)\/?$/.exec(url.pathname);
    return match && match[1] !== 'embed' ? clip(match[1]) : null;
  }
  if (!oneOf(url.hostname, ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])) return null;
  const video = /^\/videos\/(\d+)\/?$/.exec(url.pathname);
  if (video)
    return {
      kind: 'embed',
      provider: 'twitch',
      playerUrl: `https://player.twitch.tv/?video=v${video[1]}`,
    };
  const channelClip = /^\/\w{1,25}\/clip\/([\w-]+)\/?$/.exec(url.pathname);
  if (channelClip) return clip(channelClip[1]);
  const channel = /^\/(\w{1,25})\/?$/.exec(url.pathname);
  if (channel && !TWITCH_RESERVED.has(channel[1].toLowerCase()))
    return {
      kind: 'embed',
      provider: 'twitch',
      playerUrl: `https://player.twitch.tv/?channel=${channel[1].toLowerCase()}`,
    };
  return null;
}

function parseHuggingface(url: URL): ParsedEmbed | null {
  const space = (sub: string): ParsedEmbed | null => {
    const host = `${sub}.hf.space`;
    if (!HF_SPACE_HOST.test(host)) return null;
    return { kind: 'embed', provider: 'huggingface', playerUrl: `https://${host}/` };
  };
  if (HF_SPACE_HOST.test(url.hostname)) return space(url.hostname.slice(0, -'.hf.space'.length));
  if (!oneOf(url.hostname, ['huggingface.co', 'www.huggingface.co'])) return null;
  const match = /^\/spaces\/([\w.-]+)\/([\w.-]+)(?:\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  // How Hugging Face derives a Space's subdomain: owner-name, lowercased, `.`/`_` as `-`.
  return space(`${match[1]}-${match[2]}`.toLowerCase().replace(/[._]/g, '-'));
}

function parseLegacy(url: URL, input: string): ParsedEmbed | null {
  const host = url.hostname;
  if (oneOf(host, ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']))
    return /^\/(?:watch|shorts\/|embed\/|live\/)/.test(url.pathname)
      ? { kind: 'youtube', url: input }
      : null;
  if (host === 'youtu.be') return url.pathname.length > 1 ? { kind: 'youtube', url: input } : null;
  if (oneOf(host, ['instagram.com', 'www.instagram.com']))
    return /^\/(?:p|reel)\/[\w-]+\/?/.test(url.pathname) ? { kind: 'instagram', url: input } : null;
  if (oneOf(host, ['strawpoll.com', 'www.strawpoll.com']))
    return /^\/(?:polls\/|embed\/)?[\w-]+\/?$/.test(url.pathname)
      ? { kind: 'strawpoll', url: input }
      : null;
  return null;
}

/**
 * Detects an embeddable link. `null` means "not an embed": the caller inserts a plain link.
 * Bandcamp page URLs cannot be mapped client-side (the player needs the numeric item id), so
 * they come back as `bandcamp-lookup` for the server to resolve.
 */
export function parseEmbedUrl(input: string): ParsedEmbed | null {
  // A pasted embed code (`<iframe src="...">`, e.g. Bandcamp's Share → Embed) is read for its src
  // and then held to exactly the same rules as a pasted URL.
  const snippetSrc = /^\s*<iframe\b[^>]*?\ssrc=["']([^"']+)["']/i.exec(input)?.[1];
  const raw = snippetSrc ? decodeEntities(snippetSrc) : input;
  const url = parseUrl(raw, { allowHttp: true });
  if (!url) return null;
  return (
    parseLegacy(url, raw.trim()) ??
    parseBandcampPlayer(url) ??
    parseBandcampPage(url) ??
    parseSoundcloud(url) ??
    parseSpotify(url) ??
    parseVimeo(url) ??
    parseTwitch(url) ??
    parseHuggingface(url)
  );
}

/** Dialog preview for the legacy kinds; their nodes build the stored embed URL themselves. */
export function legacyPreviewSrc(kind: LegacyEmbedKind, input: string): string | null {
  const url = parseUrl(input, { allowHttp: true });
  if (!url) return null;
  const id = (re: RegExp) => re.exec(url.pathname)?.[1];
  if (kind === 'youtube') {
    const v =
      url.hostname === 'youtu.be'
        ? id(/^\/([\w-]{6,})/)
        : url.searchParams.get('v') ?? id(/^\/(?:shorts|embed|live)\/([\w-]{6,})/);
    return v && /^[\w-]+$/.test(v) ? `https://www.youtube.com/embed/${v}` : null;
  }
  if (kind === 'instagram') {
    const m = /^\/(p|reel)\/([\w-]+)/.exec(url.pathname);
    return m ? `https://www.instagram.com/${m[1]}/${m[2]}/embed` : null;
  }
  const poll = id(/^\/(?:polls\/|embed\/)?([\w-]+)\/?$/);
  return poll ? `https://www.strawpoll.com/embed/${poll}` : null;
}

/** Bandcamp page URL check for the server lookup: https only, bandcamp hosts only. */
export function parseBandcampPageUrl(input: string): URL | null {
  const url = parseUrl(input, { allowHttp: false });
  if (!url || !parseBandcampPage(url)) return null;
  return url;
}

export function bandcampPlayerUrl(type: 'track' | 'album', id: string) {
  return `https://bandcamp.com/EmbeddedPlayer/${type}=${id}/size=large/bgcol=333333/linkcol=0f91ff/tracklist=false/artwork=small/transparent=true/`;
}

// ---------------------------------------------------------------------------------------------
// Player URL validation: the only shapes a stored iframe may have
// ---------------------------------------------------------------------------------------------

function onlyParams(url: URL, allowed: string[]) {
  return [...url.searchParams.keys()].every((key) => allowed.includes(key));
}

/**
 * Returns the provider when `src` is a player URL this module would have produced, otherwise
 * null. The sanitizer drops any iframe on an EMBED_PLAYER_HOSTS / hf.space host that fails this.
 * Twitch may carry `parent`: render-time sanitizing sees the src after embedRenderSrc added it.
 * Whatever is stored is overwritten at render, so a stored value is inert.
 */
export function isAllowedPlayerUrl(src: string | undefined | null): EmbedProvider | null {
  // Absolute https only. A browser resolves `//host/x` or `/\host/x` against the page, so a
  // relative form would be a second way to spell a URL that this check never saw.
  if (!src || !/^https:\/\/[^/\\]/i.test(src)) return null;
  const url = parseUrl(src, { allowHttp: false });
  if (!url || url.hash) return null;
  const { hostname: host, pathname: path } = url;

  if (host === 'bandcamp.com')
    return /^\/EmbeddedPlayer\/(?:v=2\/)?(?:track|album)=\d+(?:\/[a-z]+=[a-z0-9]+)*\/?$/.test(
      path
    ) && !url.search
      ? 'bandcamp'
      : null;

  if (host === 'w.soundcloud.com') {
    if (!/^\/player\/?$/.test(path)) return null;
    const inner = parseUrl(url.searchParams.get('url') ?? '', { allowHttp: false });
    if (!inner || !oneOf(inner.hostname, ['soundcloud.com', 'api.soundcloud.com'])) return null;
    return onlyParams(url, ['url', 'color', 'auto_play', 'visual', 'show_artwork'])
      ? 'soundcloud'
      : null;
  }

  if (host === 'open.spotify.com')
    return /^\/embed\/(?:track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{22}\/?$/.test(
      path
    ) && onlyParams(url, ['utm_source', 'theme'])
      ? 'spotify'
      : null;

  if (host === 'player.vimeo.com')
    return /^\/video\/\d+$/.test(path) &&
      onlyParams(url, ['h']) &&
      /^[0-9a-f]*$/i.test(url.searchParams.get('h') ?? '')
      ? 'vimeo'
      : null;

  if (host === 'player.twitch.tv') {
    if (path !== '/' || !onlyParams(url, ['video', 'channel', 'parent'])) return null;
    const video = url.searchParams.get('video');
    const channel = url.searchParams.get('channel');
    if (video && !channel) return /^v\d+$/.test(video) ? 'twitch' : null;
    if (channel && !video) return /^\w{1,25}$/.test(channel) ? 'twitch' : null;
    return null;
  }

  if (host === 'clips.twitch.tv')
    return path === '/embed' &&
      onlyParams(url, ['clip', 'parent']) &&
      /^[\w-]+$/.test(url.searchParams.get('clip') ?? '')
      ? 'twitch'
      : null;

  if (HF_SPACE_HOST.test(host)) return path === '/' && !url.search ? 'huggingface' : null;

  return null;
}

/** True when the iframe host belongs to one of the new providers (and so must pass the full check). */
export function isEmbedPlayerHost(src: string | undefined | null): boolean {
  if (!src) return false;
  // Resolve the way a browser (and sanitize-html's host gate) would: protocol-relative and
  // backslash forms included. `new URL(src)` alone throws on `//x.hf.space/p`, which would let
  // that iframe skip the exact check entirely.
  let host: string;
  try {
    const normalized = src.trim().replace(/\\/g, '/');
    host = new URL(normalized, 'https://relative.invalid').hostname.toLowerCase();
  } catch {
    return false;
  }
  return oneOf(host, EMBED_PLAYER_HOSTS) || host === 'hf.space' || host.endsWith('.hf.space');
}

// ---------------------------------------------------------------------------------------------
// Render-time attributes: never stored, derived from the validated provider
// ---------------------------------------------------------------------------------------------

const FALLBACK_PARENT = 'civitai.com';

/**
 * The src to put in the DOM. Twitch refuses to play unless `parent` names the embedding page's
 * host, so it is added here from the request host rather than stored (one stored value cannot be
 * right for civitai.com, civitai.red and localhost at once).
 */
export function embedRenderSrc(provider: EmbedProvider, src: string, host?: string | null) {
  if (provider !== 'twitch') return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return src;
  }
  const parent = host?.split(':')[0] || FALLBACK_PARENT;
  url.searchParams.set('parent', parent);
  return url.toString();
}

const PLAYER_ALLOW = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';

export const EMBED_HEIGHTS: Record<EmbedProvider, number> = {
  bandcamp: 120,
  soundcloud: 166,
  spotify: 352,
  vimeo: 360,
  twitch: 378,
  huggingface: 600,
};

export function embedRenderAttrs(provider: EmbedProvider): Record<string, string> {
  if (provider === 'huggingface')
    // A Space is an arbitrary third-party app. No allow-forms (a form inside our page is a
    // phishing shape) and no allow-top-navigation (it must not be able to redirect the page).
    return { sandbox: 'allow-scripts allow-same-origin allow-popups allow-downloads' };
  return { allow: PLAYER_ALLOW };
}
