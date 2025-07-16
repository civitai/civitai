import { Node } from '@tiptap/core';

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
