import { Node, mergeAttributes } from '@tiptap/core';

export type BlurbAttrs = { id: number | null; text: string };

// Atomic and not editable in place: the text inside a blurb span is owned by the
// blurb, and hand-editing one copy would drift from the row until the next fan-out
// silently reverted it.
export const BlurbNode = Node.create({
  name: 'blurb',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => {
          const raw = (el as HTMLElement).getAttribute('data-id');
          return raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
        },
        renderHTML: (attrs) => (attrs.id ? { 'data-id': String(attrs.id) } : {}),
      },
      text: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).innerHTML,
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="blurb"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The text is emitted as children, which is what puts the materialised form in
    // editor.getHTML() and therefore in the stored column.
    // Order only controls EMITTED ATTRIBUTE ORDER (mergeAttributes puts first-argument keys
    // first, which is why `data-type` precedes `data-id` here, matching the stored round-trip
    // test) — it does NOT protect `data-type`'s value: mergeAttributes lets the LATER argument
    // win a key collision, so a future attribute whose renderHTML emits `data-type` would
    // silently override this literal. No current attribute collides; that's a known gap, not a
    // guarantee this order provides.
    return [
      'span',
      mergeAttributes({ 'data-type': 'blurb' }, HTMLAttributes),
      node.attrs.text ?? '',
    ];
  },

  renderText({ node }) {
    return node.attrs.text ?? '';
  },
});
