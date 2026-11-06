import ImageExtension from '@tiptap/extension-image';
import { imageWidthAttribute } from '~/shared/tiptap/image-width';

/** The plain `<img>` node, carrying `data-width`. Older articles, and pasted `<img>` HTML, use this node. */
export const SizedImage = ImageExtension.extend({
  addAttributes() {
    // Not `width`: the base node already owns that name for the `<img width>` HTML attribute.
    return { ...this.parent?.(), size: imageWidthAttribute };
  },
});
