import { Node } from '@tiptap/core';
import { imageWidthAttribute } from '~/shared/tiptap/image-width';

export const EdgeMediaNode = Node.create({
  name: 'media',
  atom: true,
  draggable: true,
  group: 'block',

  addAttributes() {
    return {
      url: {
        default: null,
      },
      type: {
        default: null,
      },
      filename: {
        default: null,
      },
      size: imageWidthAttribute,
    };
  },

  addOptions() {
    return {};
  },

  parseHTML() {
    return [{ tag: 'edge-media' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['edge-media', HTMLAttributes];
  },
});
