// import { generateJSON } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { renderToReactElement } from '@tiptap/static-renderer';
import React, { useMemo } from 'react';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { TextStyleKit } from '@tiptap/extension-text-style';
import ImageExtension from '@tiptap/extension-image';
import { ConsentBlockedEmbed } from '~/components/Consent/ConsentBlockedEmbed';
import { useThirdPartyConsent } from '~/components/Consent/consent.context';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { EdgeMediaComponent } from '~/components/TipTap/EdgeMediaNode';
import classes from './RichTextEditorComponent.module.scss';
import { CustomHeading } from '~/shared/tiptap/custom-heading.node';
import { EdgeMediaNode } from '~/shared/tiptap/edge-media.node';
import { MentionNode } from '~/components/TipTap/MentionNode';
import { InstagramNode } from '~/components/TipTap/InstagramNode';
import { StrawPollNode } from '~/components/TipTap/StrawPollNode';
import { CustomYoutubeNode } from '~/shared/tiptap/custom-youtube-node';
import { TimestampNode } from '~/shared/tiptap/timestamp.node';
import { LocalTimestamp } from '~/components/LocalTimestamp/LocalTimestamp';

const extensions = [
  StarterKit.configure({ heading: false }),
  CustomHeading,
  TextStyleKit,
  EdgeMediaNode,
  ImageExtension.configure({ inline: true }),
  CustomYoutubeNode,
  InstagramNode,
  MentionNode,
  StrawPollNode,
  TimestampNode,
];

export function RenderRichText({
  content,
  fallbackHtml,
}: {
  content: Record<string, any>;
  fallbackHtml?: string;
}) {
  const { allowed } = useThirdPartyConsent();
  const memoized = useMemo(() => {
    try {
      const el = renderToReactElement({
        content,
        extensions,
        options: {
          nodeMapping: {
            media: ({ node }) => <EdgeMediaComponent {...(node.attrs as any)} />,
            timestamp: ({ node }) => (
              <LocalTimestamp value={node.attrs.value} style={node.attrs.style} />
            ),
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
  }, [content, allowed]);

  if (!memoized.ok) return fallbackHtml ? <RenderHtml html={fallbackHtml} /> : null;

  return (
    <TypographyStylesWrapper className={classes.htmlRenderer}>
      <div>{memoized.el}</div>
    </TypographyStylesWrapper>
  );
}

// export function generateJSONServer(html: string, extensions: Extensions): Record<string, any> {
//   const schema = getSchema(extensions);
//   const window = new Window();
//   window.document.body.innerHTML = html;
//   const doc = new window.DOMParser().parseFromString(html, 'text/html');

//   return DOMParser.fromSchema(schema).parse(doc).toJSON();
// }
