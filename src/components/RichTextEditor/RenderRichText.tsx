// import { generateJSON } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { renderToReactElement } from '@tiptap/static-renderer';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import React, { useMemo, useRef } from 'react';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { ConsentBlockedEmbed } from '~/components/Consent/ConsentBlockedEmbed';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { EdgeMediaComponent } from '~/components/TipTap/EdgeMediaNode';
import {
  GuardedBodyMedia,
  type BodyImageGuard,
} from '~/components/RichTextEditor/GuardedBodyMedia';
import { extractCloudflareUuid } from '~/utils/article-helpers';
import { parseImageWidth } from '~/shared/tiptap/image-width';
import classes from './RichTextEditorComponent.module.scss';
import { CustomHeading } from '~/shared/tiptap/custom-heading.node';
import { EdgeMediaNode } from '~/shared/tiptap/edge-media.node';
import { SizedImage } from '~/shared/tiptap/sized-image.node';
import { MentionNode } from '~/components/TipTap/MentionNode';
import mentionClasses from '~/components/TipTap/MentionNode.module.scss';
import { mentionHref } from '~/components/RenderHtml/mention-href';
import { InstagramNode } from '~/components/TipTap/InstagramNode';
import { StrawPollNode } from '~/components/TipTap/StrawPollNode';
import { CustomYoutubeNode } from '~/shared/tiptap/custom-youtube-node';
import { TimestampNode } from '~/shared/tiptap/timestamp.node';
import { LocalTimestamp } from '~/components/LocalTimestamp/LocalTimestamp';
import { MentionHoverCard } from '~/components/UserAvatar/MentionHoverCard';
import { BlurbNode } from '~/shared/tiptap/blurb.node';
import { EmbedNode, embedIframeAttrs } from '~/shared/tiptap/embed.node';
import { isAllowedPlayerUrl } from '~/shared/utils/embed-providers';
import { useMaybeAppContext } from '~/providers/AppProvider';
import { TextAlignExtension } from '~/shared/tiptap/text-align';
import { CivitaiEmbedNode } from '~/shared/tiptap/civitai-embed.node';
import { collectCivitaiEmbedIds } from '~/shared/tiptap/civitai-embed.utils';
import { CivitaiEmbedProvider } from '~/components/CivitaiEmbed/CivitaiEmbedProvider';
import { useCurrentDomainHref } from '~/hooks/useCurrentDomainHref';
import { removeSpoilers, sanitizeBlurbInterior } from '~/utils/html-sanitize-helpers';
import { SpoilerBlockNode, SpoilerMark } from '~/shared/tiptap/spoiler.node';
import {
  SpoilerBlock,
  SpoilerRunNode,
  SpoilerText,
  groupSpoilerRuns,
} from '~/components/RichTextEditor/RichTextSpoiler';

// The feed cards are heavy and most articles hold none.
const CivitaiEmbedBlock = dynamic(() =>
  import('~/components/CivitaiEmbed/CivitaiEmbedBlock').then((m) => m.CivitaiEmbedBlock)
);

const extensions = [
  StarterKit.configure({ heading: false }),
  CustomHeading,
  TextStyleKit,
  EdgeMediaNode,
  SizedImage.configure({ inline: true }),
  CustomYoutubeNode,
  InstagramNode,
  MentionNode,
  StrawPollNode,
  TimestampNode,
  BlurbNode,
  EmbedNode,
  TextAlignExtension,
  CivitaiEmbedNode,
  SpoilerMark,
  SpoilerBlockNode,
  SpoilerRunNode,
];

type JsonNode = {
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: JsonNode[];
  [key: string]: unknown;
};

function rewriteLinkMarks(node: JsonNode, rewrite: (href: string) => string): JsonNode {
  if (!node || typeof node !== 'object') return node;
  const next = { ...node };
  if (Array.isArray(node.marks))
    next.marks = node.marks.map((mark) =>
      mark?.type === 'link' && typeof mark.attrs?.href === 'string'
        ? { ...mark, attrs: { ...mark.attrs, href: rewrite(mark.attrs.href) } }
        : mark
    );
  if (Array.isArray(node.content))
    next.content = node.content.map((child) => rewriteLinkMarks(child, rewrite));
  return next;
}

export function RenderRichText({
  content,
  fallbackHtml,
  className,
  imageGuard,
}: {
  content: Record<string, any>;
  fallbackHtml?: string;
  className?: string;
  /** Article bodies: guard each image and video by its scanned level. Omitted, media renders bare. */
  imageGuard?: BodyImageGuard;
}) {
  const { allowed } = useThirdPartyConsent();
  const contentRef = useRef<HTMLDivElement>(null);
  const toCurrentDomain = useCurrentDomainHref();
  const embedIds = useMemo(() => collectCivitaiEmbedIds(content), [content]);
  const host = useMaybeAppContext()?.host;
  const imagesByUrl = useMemo(
    () => new Map(imageGuard?.images.map((image) => [image.url, image])),
    [imageGuard?.images]
  );
  const guardNsfwLevel = imageGuard?.nsfwLevel;
  const memoized = useMemo(() => {
    // Content images are linked by Cloudflare uuid: a media node's url is one, an img's src holds one.
    const guard = (urlKey: string, size: unknown, media: React.ReactElement) => (
      <GuardedBodyMedia
        linked={imagesByUrl.get(urlKey)}
        urlKey={urlKey}
        fallbackNsfwLevel={guardNsfwLevel ?? 0}
        size={parseImageWidth(size)}
      >
        {media}
      </GuardedBodyMedia>
    );
    try {
      const el = renderToReactElement({
        content: groupSpoilerRuns(rewriteLinkMarks(content, toCurrentDomain)) as typeof content,
        extensions,
        options: {
          nodeMapping: {
            media: ({ node }) => {
              const attrs = node.attrs as any;
              if (guardNsfwLevel === undefined) return <EdgeMediaComponent {...attrs} />;
              // The width moves to the guard's box, which sizes the media inside it.
              return guard(
                attrs.url ?? '',
                attrs.size,
                <EdgeMediaComponent {...attrs} size={null} />
              );
            },
            ...(guardNsfwLevel !== undefined && {
              image: ({ node }) => {
                const { src, alt, title, size } = node.attrs as Record<string, string | null>;
                return guard(
                  extractCloudflareUuid(src ?? '') ?? src ?? '',
                  size,
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={src ?? undefined} alt={alt ?? undefined} title={title ?? undefined} />
                );
              },
            }),
            // The same profile link RenderHtml gives a comment mention, so MentionHoverCard still
            // validates it. Inside an author's link it stays a span: an <a> in an <a> is invalid
            // HTML, and the browser splits it apart on parse.
            mention: ({ node }) => {
              const { id, label } = node.attrs as { id?: string; label?: string };
              const Tag = node.marks.some((m) => m.type.name === 'link') ? 'span' : 'a';
              return (
                <Tag
                  href={Tag === 'a' ? mentionHref({ id, label }) : undefined}
                  className={mentionClasses.mention}
                  data-type="mention"
                  data-id={id}
                  data-label={label}
                >
                  @{label ?? id}
                </Tag>
              );
            },
            timestamp: ({ node }) => (
              <LocalTimestamp value={node.attrs.value} style={node.attrs.style} />
            ),
            // The static renderer's default output puts `node.attrs.text` in as an escaped text
            // child, but it's markup (bold/italic/link/code) meant to render as such. The string
            // comes out of the stored article body, which the fan-out writes via raw SQL rather
            // than zod, so this pass — not an assumed upstream one — is what makes injecting it as
            // markup safe. The save gate and the splice apply the same allowlist; this is the
            // third and last place it has to hold.
            blurb: ({ node }) => (
              <div
                data-type="blurb"
                data-id={node.attrs.id}
                dangerouslySetInnerHTML={{
                  __html: sanitizeBlurbInterior(node.attrs.text ?? '', toCurrentDomain),
                }}
              />
            ),
            spoilerRun: ({ children }) => <SpoilerText>{children}</SpoilerText>,
            spoilerBlock: ({ children }) => <SpoilerBlock>{children}</SpoilerBlock>,
            civitaiEmbed: ({ node }) => <CivitaiEmbedBlock items={node.attrs.items} />,
            embed: ({ node }) => {
              const src = node.attrs.src as string | null;
              const provider = isAllowedPlayerUrl(src);
              if (!src || !provider) return null;
              if (!allowed) return <ConsentBlockedEmbed kind={provider} />;
              const { allowfullscreen, ...attrs } = embedIframeAttrs(provider, src, host);
              return (
                <div data-type="embed" data-provider={provider}>
                  <iframe {...attrs} allowFullScreen={!!allowfullscreen} />
                </div>
              );
            },
            // For unconsented CA visitors, replace third-party embed nodes with a
            // placeholder so the iframe is never inserted in the DOM.
            ...(!allowed && {
              youtube: () => <ConsentBlockedEmbed kind="youtube" />,
              instagram: () => <ConsentBlockedEmbed kind="instagram" />,
              strawPoll: () => <ConsentBlockedEmbed kind="strawpoll" />,
            }),
          },
        },
      });
      // The flag is load-bearing: a legitimate doc can render to `null`, so the element
      // alone can't distinguish "rendered empty" from "threw".
      return { ok: true as const, el };
    } catch {
      // A node or mark type outside `extensions` throws while the doc is built, before
      // `nodeMapping` is ever consulted — so an extra mapping entry cannot absorb it, and
      // with no ErrorBoundary in the tree it blanks the whole page. `extensions` is kept in
      // sync with `tiptapExtensions` by hand, so treat drift as reachable.
      return { ok: false as const };
    }
  }, [content, allowed, toCurrentDomain, host, imagesByUrl, guardNsfwLevel]);

  if (!memoized.ok)
    // The fallback cannot mask a spoiler, so it leaves spoilers out rather than show them.
    return fallbackHtml ? (
      <RenderHtml html={removeSpoilers(fallbackHtml)} className={className} />
    ) : null;

  const body = (
    <TypographyStylesWrapper className={clsx(classes.htmlRenderer, className)}>
      <div ref={contentRef}>{memoized.el}</div>
      <MentionHoverCard containerRef={contentRef} />
    </TypographyStylesWrapper>
  );
  if (!embedIds.modelIds.length && !embedIds.imageIds.length) return body;

  return (
    <CivitaiEmbedProvider
      // A new article must not inherit the last one's results as "loaded".
      key={`${embedIds.modelIds}|${embedIds.imageIds}`}
      modelIds={embedIds.modelIds}
      imageIds={embedIds.imageIds}
    >
      {body}
    </CivitaiEmbedProvider>
  );
}

// export function generateJSONServer(html: string, extensions: Extensions): Record<string, any> {
//   const schema = getSchema(extensions);
//   const window = new Window();
//   window.document.body.innerHTML = html;
//   const doc = new window.DOMParser().parseFromString(html, 'text/html');

//   return DOMParser.fromSchema(schema).parse(doc).toJSON();
// }
