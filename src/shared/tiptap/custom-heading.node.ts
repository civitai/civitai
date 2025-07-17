import { mergeAttributes } from '@tiptap/react';
import { Heading } from '@tiptap/extension-heading';
import slugify from 'slugify';

export const CustomHeading = Heading.configure({ levels: [1, 2, 3] }).extend({
  addAttributes() {
    return {
      ...(this as any).parent?.(),
      id: { default: null },
    };
  },
  // @ts-ignore
  addOptions() {
    return {
      ...(this as any).parent?.(),
      HTMLAttributes: { id: null },
    };
  },
  // eslint-disable-next-line
  renderHTML({ node, HTMLAttributes }) {
    const hasLevel = this.options.levels.includes(node.attrs.level);
    const level: string | number = hasLevel ? node.attrs.level : this.options.levels[0];
    const id = `${slugify(node.textContent.toLowerCase())}`;

    return [`h${level}`, mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { id }), 0];
  },
});
