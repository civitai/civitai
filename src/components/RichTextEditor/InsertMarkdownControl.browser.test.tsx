import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ControlType } from '~/components/RichTextEditor/RichTextEditorComponent';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditorComponent';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * Covers the import control against a real ProseMirror. The branch that matters
 * is `editor.isEmpty ? setContent : insertContent` — it decides whether an import
 * replaces the document or splices into it, i.e. whether it can wipe a draft.
 */

const showWarning = vi.fn();
const showInfo = vi.fn();
const showError = vi.fn();

vi.mock('~/utils/notifications', () => ({
  showWarningNotification: (args: unknown) => showWarning(args),
  showInfoNotification: (args: unknown) => showInfo(args),
  showErrorNotification: (args: unknown) => showError(args),
  showSuccessNotification: vi.fn(),
}));

const CONTROLS: ControlType[] = ['heading', 'formatting', 'list', 'markdown'];

function mdFile(body: string, name = 'doc.md') {
  return new File([body], name, { type: 'text/markdown' });
}

async function mountEditor(value = '') {
  const onChange = vi.fn();
  renderWithProviders(
    <RichTextEditor value={value} onChange={onChange} includeControls={CONTROLS} />
  );

  const editor = await vi.waitFor(() => {
    const node = document.querySelector<HTMLElement>('.ProseMirror');
    if (!node) throw new Error('editor not mounted');
    return node;
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*=".md"]');
  if (!input) throw new Error('markdown file input not found');

  return { editor, input, onChange };
}

/** Drive the hidden file input the way the control's own onChange expects. */
async function pick(input: HTMLInputElement, file: File) {
  const data = new DataTransfer();
  data.items.add(file);
  Object.defineProperty(input, 'files', { value: data.files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  showWarning.mockClear();
  showInfo.mockClear();
  showError.mockClear();
});

describe('InsertMarkdownControl', () => {
  test('replaces the document when the editor is empty', async () => {
    const { editor, input } = await mountEditor();

    await pick(input, mdFile('# Imported\n\nBody text.'));

    await vi.waitFor(() => {
      if (!editor.querySelector('h1')) throw new Error('not imported yet');
    });
    expect(editor.querySelector('h1')?.textContent).toBe('Imported');
    expect(editor.textContent).toContain('Body text.');
  });

  // The destructive branch: an import must never discard existing work.
  test('keeps existing content when the editor is not empty', async () => {
    const { editor, input } = await mountEditor('<p>work in progress</p>');

    await vi.waitFor(() => {
      if (!editor.textContent?.includes('work in progress')) throw new Error('seed not applied');
    });

    await pick(input, mdFile('# Imported'));

    await vi.waitFor(() => {
      if (!editor.querySelector('h1')) throw new Error('not imported yet');
    });
    expect(editor.textContent).toContain('work in progress');
    expect(editor.textContent).toContain('Imported');
  });

  test('reports what the conversion changed', async () => {
    const { input } = await mountEditor();

    await pick(input, mdFile('| a | b |\n|---|---|\n| 1 | 2 |\n\n#### deep'));

    await vi.waitFor(() => {
      if (!showInfo.mock.calls.length) throw new Error('no notification yet');
    });
    const message = String(showInfo.mock.calls.at(-1)?.[0]?.message ?? '');
    expect(message).toContain('table');
    expect(message).toContain('heading');
  });

  test('warns instead of importing an empty file', async () => {
    const { editor, input } = await mountEditor();

    await pick(input, mdFile('   \n\n'));

    await vi.waitFor(() => {
      if (!showWarning.mock.calls.length) throw new Error('no warning yet');
    });
    expect(String(showWarning.mock.calls.at(-1)?.[0]?.message)).toMatch(/empty/i);
    expect(editor.querySelector('h1')).toBeNull();
  });

  test('warns instead of importing an oversized file', async () => {
    const { editor, input } = await mountEditor();

    await pick(input, mdFile('#'.repeat(3 * 1024 * 1024)));

    await vi.waitFor(() => {
      if (!showWarning.mock.calls.length) throw new Error('no warning yet');
    });
    expect(String(showWarning.mock.calls.at(-1)?.[0]?.message)).toMatch(/too big/i);
    expect(editor.textContent).toBe('');
  });

  test('is absent when the markdown control is not enabled', async () => {
    renderWithProviders(
      <RichTextEditor value="" onChange={vi.fn()} includeControls={['formatting']} />
    );

    await vi.waitFor(() => {
      if (!document.querySelector('.ProseMirror')) throw new Error('editor not mounted');
    });
    expect(document.querySelector('[title="Import Markdown file"]')).toBeNull();
    expect(document.querySelector('input[type="file"][accept*=".md"]')).toBeNull();
  });
});
