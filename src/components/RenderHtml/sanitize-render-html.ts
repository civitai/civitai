import { lighten, darken } from '@mantine/core';
import { mentionHref } from '~/components/RenderHtml/mention-href';
import { needsColorSwap } from '~/utils/html-helpers';
import { DEFAULT_ALLOWED_ATTRIBUTES, sanitizeHtml } from '~/utils/html-sanitize-helpers';
import { toCurrentDomainHref } from '~/utils/current-domain-href';
import {
  EMBED_PLAYER_ALLOW,
  embedRenderSrc,
  isAllowedPlayerUrl,
  isEmbedPlayerHost,
} from '~/shared/utils/embed-providers';
import { getProfanityFilter } from '~/libs/profanity-simple';
import { maskProfanityOutsideMarkup } from './mask-profanity';

/**
 * Everything RenderHtml's sanitize output depends on besides the HTML itself. The sanitizer below
 * reads nothing else (apart from module constants), which is what makes caching its output by
 * `(html, options)` safe — so a new input to the sanitizer must be added HERE, and the mapped type
 * on `optionsKey` then refuses to compile until it is part of the cache key too.
 */
export type RenderHtmlSanitizeOptions = {
  /** `withProfanityFilter && blurNsfw` at the call site. */
  maskProfanity: boolean;
  allowStickers: boolean;
  allowCustomStyles: boolean;
  colorScheme: 'light' | 'dark';
  withMentions: boolean;
  thirdPartyAllowed: boolean;
  /** Request host, for embed URLs and same-domain link rewriting. */
  host: string | null | undefined;
  /** Our own hosts (getOwnHosts(serverDomains)), for same-domain link rewriting. */
  ownHosts: readonly string[];
};

/** The uncached sanitizer. Pure in `(html, options)`. */
export function sanitizeRenderHtml(html: string, options: RenderHtmlSanitizeOptions): string {
  const {
    maskProfanity,
    allowStickers,
    allowCustomStyles,
    colorScheme,
    withMentions,
    thirdPartyAllowed,
    host,
    ownHosts,
  } = options;

  let processedHtml = html;
  if (maskProfanity) {
    // Shared cache, not a fresh filter: this runs per COMPONENT INSTANCE, so a 20-comment
    // thread was building 20 full obscenity datasets (~6ms each).
    processedHtml = maskProfanityOutsideMarkup(processedHtml, getProfanityFilter());
  }

  return sanitizeHtml(processedHtml, {
    allowStickers,
    parseStyleAttributes: allowCustomStyles,
    allowedAttributes: {
      ...DEFAULT_ALLOWED_ATTRIBUTES,
      div: ['data-youtube-video', 'data-type', 'data-provider', 'style', 'data-consent-blocked'],
      // Set by the iframe transform below from the validated provider; any stored value is
      // dropped there first.
      iframe: [...DEFAULT_ALLOWED_ATTRIBUTES.iframe, 'allow'],
      // Attributes are filtered against the tag a transform produced, so the
      // mention span's data attributes are dropped once it becomes a link
      // unless `a` allows them too. The hover card reads the user from them.
      a: [...DEFAULT_ALLOWED_ATTRIBUTES.a, 'data-type', 'data-id', 'data-label'],
    },
    allowedStyles: allowCustomStyles
      ? {
          div: { height: [/^\d+px$/] },
        }
      : undefined,
    transformTags: {
      // For unconsented CA visitors, replace third-party iframes with a
      // placeholder div so no third-party network request fires. The kind
      // attribute drives the CSS-only placeholder shown in its place.
      iframe: function (_tagName, { allow: _allow, ...attribs }) {
        if (thirdPartyAllowed) {
          const provider = isAllowedPlayerUrl(attribs.src);
          if (!provider) {
            // Runs before sanitizeHtml's exclusive filter: a provider-host src that is not a
            // player URL is removed here, so the iframe stays empty and never loads.
            if (isEmbedPlayerHost(attribs.src)) delete attribs.src;
            return { tagName: 'iframe', attribs };
          }
          return {
            tagName: 'iframe',
            attribs: {
              ...attribs,
              src: embedRenderSrc(provider, attribs.src, host),
              allow: EMBED_PLAYER_ALLOW,
            },
          };
        }
        return {
          tagName: 'div',
          attribs: {
            'data-consent-blocked': embedKindFromUrl(attribs.src),
          },
          text: '',
        };
      },
      div: function (tagName, attribs) {
        if (attribs['data-type'] !== 'strawPoll') delete attribs.style;
        // data-consent-blocked is whitelisted in allowedAttributes so the
        // iframe→div transform above can set it. Strip it from
        // user-authored divs so people can't spawn fake "content blocked"
        // placeholders by hand-writing the attribute in their HTML.
        delete attribs['data-consent-blocked'];
        return {
          tagName,
          attribs,
        };
      },
      span: function (tagName, attribs) {
        const dataType = attribs['data-type'];
        const isMention = dataType === 'mention';
        const style = attribs['style'];
        let hexColor = style?.match(/color:#([0-9a-f]{6})/)?.[1];
        const [, r, g, b] = style?.match(/color:rgba?\((\d+), (\d+), (\d+),? ?(\d+)?\)/) ?? [];
        const rgbColors = [r, g, b]
          .map((color) => {
            const value = parseInt(color, 10);
            if (isNaN(value)) return '';
            return value.toString(16).padStart(2, '0');
          })
          .filter(Boolean);

        if (rgbColors.length === 3) hexColor = rgbColors.join('');

        const needsSwap = hexColor
          ? needsColorSwap({
              hexColor,
              colorScheme,
              threshold: 0.2,
            })
          : false;

        return withMentions && isMention
          ? {
              tagName: 'a',
              attribs: {
                ...attribs,
                href: mentionHref({ id: attribs['data-id'], label: attribs['data-label'] }),
              },
            }
          : {
              tagName,
              attribs: {
                ...attribs,
                style:
                  needsSwap && hexColor
                    ? style +
                      `;color:${
                        colorScheme === 'dark' ? lighten(hexColor, 0.5) : darken(hexColor, 0.3)
                      }`
                    : style,
              },
            };
      },
      a: function (tagName, attribs) {
        if (attribs.href) attribs.href = toCurrentDomainHref(attribs.href, host, ownHosts);

        return {
          tagName,
          attribs,
        };
      },
    },
  });
}

// Match host exactly or as a subdomain (e.g. "www.youtube.com"), never as a
// substring elsewhere in the URL — `url.includes('youtube.com')` would let
// `https://evil.com/?x=youtube.com` masquerade as a YouTube embed.
function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function embedKindFromUrl(url: string | undefined): string {
  if (!url) return 'embed';
  let host: string;
  try {
    host = new URL(url, 'https://placeholder.invalid').hostname.toLowerCase();
  } catch {
    return 'embed';
  }
  if (hostMatches(host, 'youtube.com') || hostMatches(host, 'youtu.be')) return 'youtube';
  if (hostMatches(host, 'instagram.com')) return 'instagram';
  if (hostMatches(host, 'strawpoll.com')) return 'strawpoll';
  return isAllowedPlayerUrl(url) ?? 'embed';
}

/**
 * One string per option. The mapped type is the guard: an option added to
 * RenderHtmlSanitizeOptions without a key part here is a type error, so the cache can never be
 * keyed on fewer inputs than the sanitizer reads.
 */
export function optionsKey(options: RenderHtmlSanitizeOptions): string {
  const parts: { [K in keyof RenderHtmlSanitizeOptions]: string } = {
    maskProfanity: options.maskProfanity ? '1' : '0',
    allowStickers: options.allowStickers ? '1' : '0',
    allowCustomStyles: options.allowCustomStyles ? '1' : '0',
    colorScheme: options.colorScheme,
    withMentions: options.withMentions ? '1' : '0',
    thirdPartyAllowed: options.thirdPartyAllowed ? '1' : '0',
    host: JSON.stringify(options.host ?? null),
    ownHosts: JSON.stringify(options.ownHosts),
  };
  // A separator no flag, colour scheme or JSON-encoded string can contain unescaped.
  return Object.values(parts).join('\u0001');
}

// Bounded by entry count AND by total characters held (input + output), oldest entry evicted
// first. One oversized description is never cached rather than flushing everything else.
export const SANITIZE_CACHE_MAX_ENTRIES = 500;
export const SANITIZE_CACHE_MAX_CHARS = 4_000_000;
const SANITIZE_CACHE_MAX_ENTRY_CHARS = 200_000;

type CacheEntry = { value: string; chars: number };
const sanitizeCache = new Map<string, CacheEntry>();
let sanitizeCacheChars = 0;

/**
 * `sanitizeRenderHtml`, memoized across renders and component instances: the same description is
 * typically rendered many times (every view of a model page, every remount), and the sanitizer
 * parses and re-serialises the whole document each time. The key is the exact input string plus
 * every option, so a hit returns exactly what the sanitizer would have produced.
 *
 * `sanitize` is injectable for the tests only.
 */
export function getSanitizedRenderHtml(
  html: string,
  options: RenderHtmlSanitizeOptions,
  sanitize: typeof sanitizeRenderHtml = sanitizeRenderHtml
): string {
  const key = `${optionsKey(options)}\u0000${html}`;
  const hit = sanitizeCache.get(key);
  if (hit) return hit.value;

  const value = sanitize(html, options);
  const chars = key.length + value.length;
  if (chars <= SANITIZE_CACHE_MAX_ENTRY_CHARS) {
    sanitizeCache.set(key, { value, chars });
    sanitizeCacheChars += chars;
    while (
      sanitizeCache.size > SANITIZE_CACHE_MAX_ENTRIES ||
      sanitizeCacheChars > SANITIZE_CACHE_MAX_CHARS
    ) {
      const oldest = sanitizeCache.keys().next();
      if (oldest.done) break;
      const evicted = sanitizeCache.get(oldest.value);
      sanitizeCache.delete(oldest.value);
      sanitizeCacheChars -= evicted?.chars ?? 0;
    }
  }
  return value;
}

/** Test-only introspection and reset. */
export const sanitizeCacheForTests = {
  size: () => sanitizeCache.size,
  chars: () => sanitizeCacheChars,
  clear: () => {
    sanitizeCache.clear();
    sanitizeCacheChars = 0;
  },
};
