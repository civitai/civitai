import TextAlign from '@tiptap/extension-text-align';

export type TextAlignment = 'left' | 'center' | 'right';

// Shared by the editor and every reader: an extension missing from one of them drops the
// alignment when the document is parsed or rendered there.
export const TextAlignExtension = TextAlign.configure({
  types: ['heading', 'paragraph'],
  alignments: ['left', 'center', 'right'],
});
