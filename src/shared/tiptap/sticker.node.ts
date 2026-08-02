import { mergeAttributes, Node } from '@tiptap/core';
import { formatStickerToken } from '~/shared/utils/sticker-token';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    sticker: {
      /** Insert a sticker at the current selection. */
      setSticker: (attributes: { id: number; slug?: string }) => ReturnType;
    };
  }
}

/**
 * Tiptap node for a purchased sticker. Serializes to
 * `<span data-type="sticker" data-id="…">`, which the comment sanitizers already
 * permit — they override `allowedTags` to strip `img` but leave
 * `DEFAULT_ALLOWED_ATTRIBUTES`' `span: ['class','data-type','data-id','data-label',…]`
 * intact, the same mechanism @mentions ride on. That is why this is a span and
 * not an image: widening the comment allowlist to `img` would open a general
 * image-embed hole.
 *
 * Registered by the editor only. `RenderRichText` deliberately does NOT register
 * it: its one consumer is the article page, articles are not a sticker surface,
 * and registering it there let a crafted `contentJson` draw a paid sticker with
 * no ownership check.
 */
export const StickerNode = Node.create({
  name: 'sticker',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => ({ 'data-id': attributes.id }),
      },
      // Carried for the text fallback and copy/paste; the id is authoritative.
      slug: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-label'),
        renderHTML: (attributes) => (attributes.slug ? { 'data-label': attributes.slug } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="sticker"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'sticker' })];
  },

  renderText({ node }) {
    const id = Number(node.attrs.id);
    return Number.isFinite(id) ? formatStickerToken(id) : '';
  },

  addCommands() {
    return {
      setSticker:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { id: String(attributes.id), slug: attributes.slug ?? null },
          }),
    };
  },
});
