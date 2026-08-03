import { Alert, Code, Divider, Stack, Text, Title } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import React, { useState } from 'react';
import type { ControlType } from '~/components/RichTextEditor/RichTextEditorComponent';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditorComponent';

// `.ladle/components.tsx` only loads @mantine/core styles, so the editor's own
// stylesheets have to come in here or the toolbar renders unstyled.
//
// The `.layer.css` variants specifically, matching _app.tsx: the plain builds are
// unlayered, and unlayered CSS outranks every layered rule — including CSS
// modules, which Next wraps in `@layer modules`. Importing those here would let
// Mantine override module styles it doesn't override in the real app, so the
// preview would misreport the styling.
import '@mantine/tiptap/styles.layer.css';
import '@mantine/notifications/styles.layer.css';

/**
 * Manual harness for the article editor. Runs the real component with the same
 * `includeControls` the article form passes, with no DB / auth / tRPC — so
 * the Import Markdown button can be tried by hand.
 */

const ARTICLE_CONTROLS = [
  'heading',
  'formatting',
  'list',
  'link',
  'media',
  'video',
  'polls',
  'colors',
  'timestamp',
  'markdown',
] satisfies ControlType[];

function Harness({ controls }: { controls: ControlType[] }) {
  const [html, setHtml] = useState('');

  return (
    <>
      <Notifications />
      <Stack gap="md" style={{ width: 'min(1100px, calc(100vw - 380px))', minWidth: 520 }}>
        <div>
          <Title order={4}>Article editor</Title>
          <Text size="sm" c="dimmed">
            Use the last toolbar button to import a .md file. Pasting markdown source is not
            converted — a paste can&apos;t be told apart from code or a shell transcript.
          </Text>
        </div>

        <Alert color="blue" p="xs">
          <Text size="xs">
            Tables arrive as nested lists and H4+ collapse to H3 — the article sanitizer has no tag
            for them. Blockquotes, headings, lists, code and inline marks are kept as-is.
          </Text>
        </Alert>

        <RichTextEditor
          value={html}
          onChange={setHtml}
          includeControls={controls}
          editorSize="xl"
          placeholder="Import a .md file, or write here…"
        />

        <Divider label="onChange output (this is what gets submitted)" labelPosition="left" />
        <Code block style={{ maxHeight: 320, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {html || '(empty)'}
        </Code>
      </Stack>
    </>
  );
}

export const ArticleEditor = () => <Harness controls={ARTICLE_CONTROLS} />;

/** The comment/review configuration — no import button here. */
export const WithoutMarkdownSupport = () => <Harness controls={['formatting', 'link']} />;
