import type { TypographyStylesProviderProps } from '@mantine/core';
import { useComputedColorScheme } from '@mantine/core';
import { useEffect, useMemo, useRef } from 'react';
import { formatDiscordTimestamp, normalizeTimestampStyle } from '~/utils/timestamp-helpers';

import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { useCurrentDomainHosts } from '~/hooks/useCurrentDomainHref';
import { getSanitizedRenderHtml } from './sanitize-render-html';
import classes from './RenderHtml.module.scss';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import clsx from 'clsx';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import {
  STICKER_JUMBO_LIMIT,
  stickerInlineStyle,
  stickerMaxWidth,
  STICKER_SIZE,
} from '~/shared/utils/sticker-token';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { MentionHoverCard } from '~/components/UserAvatar/MentionHoverCard';
import { StickerAttributionHoverCard } from '~/components/Sticker/StickerAttributionHoverCard';

export function RenderHtml({
  html,
  withMentions = false,
  allowCustomStyles = true,
  withProfanityFilter = false,
  allowStickers = false,
  className,
  ...props
}: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);
  const { allowed: thirdPartyAllowed } = useThirdPartyConsent();
  const contentRef = useRef<HTMLDivElement>(null);
  const { host, ownHosts } = useCurrentDomainHosts();

  html = useMemo(
    () =>
      getSanitizedRenderHtml(html, {
        maskProfanity: withProfanityFilter && blurNsfw,
        allowStickers,
        allowCustomStyles,
        colorScheme,
        withMentions,
        thirdPartyAllowed,
        host,
        ownHosts,
      }),
    [
      html,
      blurNsfw,
      allowCustomStyles,
      colorScheme,
      withMentions,
      withProfanityFilter,
      thirdPartyAllowed,
      allowStickers,
      host,
      ownHosts,
    ]
  );

  // Stored comment content carries stickers as empty `<span data-type="sticker">`
  // elements. Resolve their art and fill them in on the client, the same
  // post-mount hydration the timestamps below use.
  const stickerIds = useMemo(() => {
    if (!allowStickers) return [];
    const ids = [...html.matchAll(/data-type="sticker"[^>]*data-id="(\d{1,9})"/g)].map((m) =>
      Number(m[1])
    );
    const reversed = [...html.matchAll(/data-id="(\d{1,9})"[^>]*data-type="sticker"/g)].map((m) =>
      Number(m[1])
    );
    return [...new Set([...ids, ...reversed])];
  }, [html, allowStickers]);
  const { sticker: stickerById } = useStickerCosmetics(stickerIds);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || !stickerIds.length) return;
    // Same jumbo rule as chat, applied per block: a paragraph containing only
    // stickers renders them large. `parseStickerLines` can't be reused directly
    // because the content here is DOM, not the raw token string, so the rule is
    // re-derived from the same STICKER_JUMBO_LIMIT rather than duplicated.
    const jumboBlocks = new Set<Element>();
    container.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6').forEach((block) => {
      const stickers = block.querySelectorAll(':scope > span[data-type="sticker"]');
      if (!stickers.length || stickers.length > STICKER_JUMBO_LIMIT) return;
      const withoutStickers = Array.from(block.childNodes)
        .filter((n) => !(n instanceof Element && n.matches('span[data-type="sticker"]')))
        .map((n) => n.textContent ?? '')
        .join('');
      if (!withoutStickers.trim()) jumboBlocks.add(block);
    });

    container.querySelectorAll<HTMLSpanElement>('span[data-type="sticker"]').forEach((node) => {
      const resolved = stickerById.get(Number(node.getAttribute('data-id')));
      if (!resolved) return;
      const size =
        node.parentElement && jumboBlocks.has(node.parentElement)
          ? STICKER_SIZE.jumbo
          : STICKER_SIZE.inline;
      const img = document.createElement('img');
      img.src = getEdgeUrl(resolved.url, {
        height: size * 2,
        anim: resolved.animated,
        optimized: true,
      });
      img.alt = `:${resolved.slug}:`;
      img.title = `:${resolved.slug}:`;
      img.style.height = `${size}px`;
      img.style.width = 'auto';
      img.style.maxWidth = `${stickerMaxWidth(size)}px`;
      img.style.objectFit = 'contain';
      img.style.display = 'inline-block';
      Object.assign(img.style, stickerInlineStyle(size));
      node.replaceChildren(img);
    });
  }, [html, stickerById, stickerIds]);

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
      {/* Not gated on `withMentions` — that prop only decides whether a mention
          becomes a link. The span carries the user either way. */}
      <MentionHoverCard containerRef={contentRef} />
      {/* Behind the same opt-in as drawing the sticker at all, so a surface that
          stores unsanitized HTML cannot acquire a shop link by acquiring a
          sticker. */}
      {allowStickers && stickerIds.length > 0 && (
        <StickerAttributionHoverCard containerRef={contentRef} />
      )}
    </TypographyStylesWrapper>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & {
  html: string;
  withMentions?: boolean;
  allowCustomStyles?: boolean;
  withProfanityFilter?: boolean;
  /**
   * Opt in to drawing sticker cosmetics. Defaults off so a surface that stores
   * unsanitized HTML can't render a paid sticker for free, and so any rich-text
   * surface added later fails closed. Only the comment sites pass it.
   */
  allowStickers?: boolean;
};
