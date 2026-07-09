import type { TypographyStylesProviderProps } from '@mantine/core';
import { useComputedColorScheme, lighten, darken } from '@mantine/core';
import { useEffect, useMemo, useRef } from 'react';
import { formatDiscordTimestamp, normalizeTimestampStyle } from '~/utils/timestamp-helpers';

import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { needsColorSwap } from '~/utils/html-helpers';
import { DEFAULT_ALLOWED_ATTRIBUTES, sanitizeHtml } from '~/utils/html-sanitize-helpers';
import classes from './RenderHtml.module.scss';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import clsx from 'clsx';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

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
  return 'embed';
}

export function RenderHtml({
  html,
  withMentions = false,
  allowCustomStyles = true,
  withProfanityFilter = false,
  className,
  ...props
}: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);
  const { allowed: thirdPartyAllowed } = useThirdPartyConsent();
  const contentRef = useRef<HTMLDivElement>(null);

  html = useMemo(() => {
    let processedHtml = html;
    if (withProfanityFilter && blurNsfw) {
      const profanityFilter = createProfanityFilter();

      // Preserve mentions (entire span + content) and all HTML tag markup so
      // the filter only operates on visible text content. Capturing entire
      // tags also protects href/src attribute values, since the whole opening
      // tag is one match. The per-render nonce prevents collisions with any
      // user-typed text that happens to look like a placeholder.
      const nonce = Math.random().toString(36).slice(2, 12);
      const mentionToken = (i: number) => `__pf${nonce}M${i}__`;
      const tagToken = (i: number) => `__pf${nonce}T${i}__`;

      const mentionRegex = /<span[^>]*data-type="mention"[^>]*>.*?<\/span>/gi;
      const tagRegex = /<[^>]+>/g;

      const mentions: string[] = [];
      processedHtml = processedHtml.replace(mentionRegex, (match) => {
        mentions.push(match);
        return mentionToken(mentions.length - 1);
      });

      const tags: string[] = [];
      processedHtml = processedHtml.replace(tagRegex, (match) => {
        tags.push(match);
        return tagToken(tags.length - 1);
      });

      processedHtml = profanityFilter.clean(processedHtml);

      // Single-pass O(n) restore per type via global regex callback.
      processedHtml = processedHtml.replace(
        new RegExp(`__pf${nonce}T(\\d+)__`, 'g'),
        (_, index) => tags[Number(index)] ?? ''
      );
      processedHtml = processedHtml.replace(
        new RegExp(`__pf${nonce}M(\\d+)__`, 'g'),
        (_, index) => mentions[Number(index)] ?? ''
      );
    }

    return sanitizeHtml(processedHtml, {
      parseStyleAttributes: allowCustomStyles,
      allowedAttributes: {
        ...DEFAULT_ALLOWED_ATTRIBUTES,
        div: ['data-youtube-video', 'data-type', 'style', 'data-consent-blocked'],
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
        iframe: function (_tagName, attribs) {
          if (thirdPartyAllowed) return { tagName: 'iframe', attribs };
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
                  href: `/user/${attribs['data-label'] ?? attribs['data-id']}`,
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
          if (typeof window !== 'undefined' && attribs.href)
            attribs.href = attribs.href.replace('//civitai.com', `//${location.host}`);

          return {
            tagName,
            attribs,
          };
        },
      },
    });
  }, [
    html,
    blurNsfw,
    allowCustomStyles,
    colorScheme,
    withMentions,
    withProfanityFilter,
    thirdPartyAllowed,
  ]);

  // RenderHtml injects a raw HTML string, so Discord-style `<t:...>` timestamps
  // arrive as `<time data-type="timestamp">` elements carrying a UTC fallback.
  // Rewrite them to the viewer's local time once mounted on the client.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLTimeElement>('time[data-type="timestamp"]');
    nodes.forEach((node) => {
      const seconds = parseInt(node.getAttribute('data-value') ?? '', 10);
      if (!Number.isFinite(seconds)) return;
      const style = normalizeTimestampStyle(node.getAttribute('data-style'));
      node.textContent = formatDiscordTimestamp(seconds, style);
      node.title = formatDiscordTimestamp(seconds, 'F');
    });
  }, [html]);

  return (
    <TypographyStylesWrapper {...props} className={clsx(classes.htmlRenderer, className)}>
      <div ref={contentRef} dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesWrapper>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & {
  html: string;
  withMentions?: boolean;
  allowCustomStyles?: boolean;
  withProfanityFilter?: boolean;
};
