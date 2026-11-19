import type { Attribute } from '@tiptap/core';

/** Per-image size in the article editor, as a percentage of the column. */
export const IMAGE_WIDTHS = ['33', '50', '75', '100'] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export function parseImageWidth(value: unknown): ImageWidth | null {
  const str = typeof value === 'number' ? String(value) : value;
  return IMAGE_WIDTHS.includes(str as ImageWidth) ? (str as ImageWidth) : null;
}

/** Node attribute `size`, stored in HTML as `data-width`. */
export const imageWidthAttribute: Attribute = {
  default: null,
  parseHTML: (element) => parseImageWidth(element.getAttribute('data-width')),
  renderHTML: (attributes) => {
    const width = parseImageWidth(attributes.size);
    return width ? { 'data-width': width } : {};
  },
};
