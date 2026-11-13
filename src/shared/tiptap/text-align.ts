import TextAlign from '@tiptap/extension-text-align';

export type TextAlignment = 'left' | 'center' | 'right';

// Must be in the editor, tiptapExtensions and RenderRichText: any parser or renderer without it
// drops the alignment.
export const TextAlignExtension = TextAlign.configure({
  types: ['heading', 'paragraph'],
  alignments: ['left', 'center', 'right'],
});
