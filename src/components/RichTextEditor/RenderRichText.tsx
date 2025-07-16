// import { generateJSON } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  renderToHTMLString,
  renderToMarkdown,
  renderToReactElement,
} from '@tiptap/static-renderer';
import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import { Color } from '@tiptap/extension-color';
import Heading from '@tiptap/extension-heading';
import Mention from '@tiptap/extension-mention';
import { TextStyleKit } from '@tiptap/extension-text-style';
import ImageExtension from '@tiptap/extension-image';
import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import Youtube from '@tiptap/extension-youtube';
import { EdgeMediaNode, EdgeMediaNodePreview } from '~/components/RichTextEditor/EdgeMediaNode';
import classes from './RichTextEditorComponent.module.scss';
import { generateJSON } from '@tiptap/html';
// import { generateJSON as generateJSONServer } from '@tiptap/html/server';
import type { Extensions, JSONContent } from '@tiptap/core';
import { getSchema } from '@tiptap/core';
import { DOMParser, DOMSerializer, Node } from '@tiptap/pm/model';
import { Window } from 'happy-dom-without-node';

const extensions = [
  StarterKit,
  TextStyleKit,
  Color,
  EdgeMediaNode,
  ImageExtension.configure({ inline: true }),
  Youtube.configure({
    addPasteHandler: false,
    modestBranding: false,
  }),
  Instagram.configure({
    HTMLAttributes: { class: classes.instagramEmbed },
    height: 'auto',
  }),
  Mention.configure({
    HTMLAttributes: {
      class: classes.mention,
    },
    renderLabel({ options, node }) {
      const label = node.attrs.label ?? node.attrs.id;
      return `${options.suggestion.char ?? ''}${typeof label === 'string' ? label : ''}`;
    },
  }),
  StrawPoll.configure({
    HTMLAttributes: { class: classes.strawPollEmbed },
    height: 'auto',
  }),
];

export function RenderRichText({ content }: { content: Record<string, any> }) {
  const memoized = useMemo(() => {
    return renderToReactElement({
      content,
      extensions,
      options: {
        nodeMapping: {
          media: ({ node }) => <EdgeMediaNodePreview {...(node.attrs as any)} />,
        },
      },
    });
  }, [content]);

  return (
    <TypographyStylesWrapper>
      <div>{memoized}</div>
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
