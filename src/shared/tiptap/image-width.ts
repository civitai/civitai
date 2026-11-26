import type { Attribute } from '@tiptap/core';

const DRAG_WIDTHS = Array.from({ length: 18 }, (_, i) => String(10 + i * 5)); // 10 … 95
/** Per-image size in the article editor, as a percentage of the column. 33 is a retired preset. */
export const IMAGE_WIDTHS = [...DRAG_WIDTHS, '33', '100'] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export function parseImageWidth(value: unknown): ImageWidth | null {
  const str = typeof value === 'number' ? String(value) : value;
  return IMAGE_WIDTHS.includes(str as ImageWidth) ? (str as ImageWidth) : null;
}

/** A dragged width, as a stored size: snapped to 5%, 10–95, and null for the full column. */
export function snapImageWidth(percent: number): ImageWidth | null {
  const snapped = Math.min(100, Math.max(10, Math.round(percent / 5) * 5));
  return snapped === 100 ? null : (String(snapped) as ImageWidth);
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

export const IMAGE_ALIGNS = ['left', 'center', 'right', 'float-left', 'float-right'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];

export function parseImageAlign(value: unknown): ImageAlign | null {
  return IMAGE_ALIGNS.includes(value as ImageAlign) ? (value as ImageAlign) : null;
}

/** Node attribute `align`, stored in HTML as `data-align`. */
export const imageAlignAttribute: Attribute = {
  default: null,
  parseHTML: (element) => parseImageAlign(element.getAttribute('data-align')),
  renderHTML: (attributes) => {
    const align = parseImageAlign(attributes.align);
    return align ? { 'data-align': align } : {};
  },
};
