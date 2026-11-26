import { mergeAttributes, Node } from '@tiptap/core';
import { WITHHELD_MEDIA_TYPE } from '~/shared/constants/withheld-media.constants';

/**
 * A body image the editor may not see: a placeholder the save swaps back for the stored image.
 * Only `data-id` (its position among the stored body's media) round-trips; it carries no source.
 */
export const WithheldMediaNode = Node.create({
  name: WITHHELD_MEDIA_TYPE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-id'),
        renderHTML: (attributes) => ({ 'data-id': attributes.id }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${WITHHELD_MEDIA_TYPE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': WITHHELD_MEDIA_TYPE }, HTMLAttributes)];
  },
});
