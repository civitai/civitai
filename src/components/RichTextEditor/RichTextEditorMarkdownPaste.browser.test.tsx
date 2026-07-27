import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditorComponent';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Exercises the markdown paste handler against a REAL ProseMirror instance.
 *
 * The pure conversion is covered in src/utils/__tests__/markdown-to-editor-html.test.ts.
 * What can only be checked in a browser is the wiring: that `editorProps.handlePaste`
 * is reached, that it wins over ProseMirror's default plain-text insert, and that the
 * converted HTML is accepted by the editor's schema rather than silently dropped.
 *
 * Imports RichTextEditorComponent directly — the `RichTextEditor.tsx` barrel is a
 * `next/dynamic({ ssr: false })` shim whose lazy boundary would just add flake here.
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
] as const;

const MARKDOWN = [
  '## Look 1',
  '',
  '> Diamond-pattern chaos.',
  '',
  '```',
  '1girl, solo, masterpiece',
  '```',
  '',
  '| Generator | Dialect |',
  '|---|---|',
  '| Flux | NL |',
].join('\n');

async function mountEditor(controls: readonly string[] = ARTICLE_CONTROLS, onChange = vi.fn()) {
  renderWithProviders(
    <RichTextEditor
      value=""
      onChange={onChange}
      includeControls={controls as never}
      editorSize="xl"
    />
  );

  const editor = await vi.waitFor(() => {
    const node = document.querySelector<HTMLElement>('.ProseMirror');
    if (!node) throw new Error('editor not mounted');
    return node;
  });

  return { editor, onChange };
}

function paste(target: HTMLElement, text: string, html?: string) {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (html) data.setData('text/html', html);

  target.focus();
  target.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  );
}

describe('markdown paste', () => {
  test('converts pasted markdown source into real editor nodes', async () => {
    const { editor } = await mountEditor();

    paste(editor, MARKDOWN);

    await vi.waitFor(() => {
      if (!editor.querySelector('h2')) throw new Error('heading not rendered yet');
    });

    expect(editor.querySelector('h2')?.textContent).toBe('Look 1');
    expect(editor.querySelector('blockquote')?.textContent).toContain('Diamond-pattern chaos.');
    expect(editor.querySelector('pre code')?.textContent).toContain('1girl, solo, masterpiece');

    // The table is down-converted, so it must NOT arrive as a real table.
    expect(editor.querySelector('table')).toBeNull();
    expect(editor.textContent).toContain('Generator');

    // Raw markers must be gone — that's the bug this fixes.
    expect(editor.textContent).not.toContain('## Look 1');
    expect(editor.textContent).not.toContain('> Diamond');
  });

  test('reports the converted HTML through onChange', async () => {
    const { editor, onChange } = await mountEditor();

    paste(editor, MARKDOWN);

    await vi.waitFor(() => {
      if (!onChange.mock.calls.length) throw new Error('onChange not called yet');
    });

    // `<h2` not `<h2>` — CustomHeading adds a slug id (`<h2 id="look-1">`),
    // which the sanitizer keeps via its `'*': ['id']` rule.
    const html = onChange.mock.calls.at(-1)?.[0] as string;
    expect(html).toContain('<h2');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre>');
  });

  test('leaves plain prose alone', async () => {
    const { editor } = await mountEditor();
    const prose = 'Just a sentence about a model I liked.';

    paste(editor, prose);

    await vi.waitFor(() => {
      if (!editor.textContent?.includes('model I liked')) throw new Error('not pasted yet');
    });

    expect(editor.querySelector('h2')).toBeNull();
    expect(editor.querySelector('blockquote')).toBeNull();
    expect(editor.textContent).toContain(prose);
  });

  test('does not convert when the markdown control is disabled', async () => {
    const { editor } = await mountEditor(['formatting', 'link']);

    paste(editor, MARKDOWN);

    await vi.waitFor(() => {
      if (!editor.textContent?.includes('Look 1')) throw new Error('not pasted yet');
    });

    // No handler registered, so ProseMirror inserts the source verbatim.
    expect(editor.querySelector('h2')).toBeNull();
    expect(editor.textContent).toContain('## Look 1');
  });

  test('renders the Import Markdown control only when enabled', async () => {
    await mountEditor();
    expect(document.querySelector('[title="Import Markdown file"]')).not.toBeNull();
  });
});
