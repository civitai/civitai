import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { looksLikeMarkdown } from '~/utils/markdown-detect';

/**
 * Converts pasted markdown source, which tiptap otherwise inserts verbatim —
 * input rules fire on typing, and the built-in paste rules only cover inline
 * marks, so headings, fences, lists and tables arrive as literal characters.
 *
 * An extension rather than `editorProps.handlePaste` for two reasons: `this
 * .editor` is available here (no ref that is still empty during mount), and
 * passing `editorProps` at all makes tiptap's reference-comparing `useEditor`
 * re-run `setOptions` on every render.
 */
export const MarkdownPaste = Extension.create({
  name: 'markdownPaste',

  addProseMirrorPlugins() {
    const { editor } = this;

    return [
      new Plugin({
        key: new PluginKey('markdownPaste'),
        props: {
          handlePaste: (_view, event) => {
            // Decided on the plain-text flavour alone: editors ship
            // syntax-highlighted HTML alongside the source, so gating on
            // text/html would paste coloured spans instead of converting.
            const text = event.clipboardData?.getData('text/plain');
            if (!text || !looksLikeMarkdown(text)) return false;

            event.preventDefault();

            // Loaded on demand so the markdown stack stays out of the chunk
            // every other editor surface downloads. Falls back to the raw text
            // so a failed import can't swallow the paste we just cancelled.
            import('~/utils/markdown-to-editor-html')
              .then(({ markdownToEditorHtml }) => {
                const html = markdownToEditorHtml(text);
                editor.commands.insertContent(html.trim() ? html : text);
              })
              .catch(() => editor.commands.insertContent(text));

            return true;
          },
        },
      }),
    ];
  },
});
