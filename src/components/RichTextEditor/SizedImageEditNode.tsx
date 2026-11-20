import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { parseImageAlign, parseImageWidth } from '~/shared/tiptap/image-width';
import { SizedImage } from '~/shared/tiptap/sized-image.node';
import { ResizableImageFrame, resizeAndKeepSelected } from './ResizableImageFrame';

/** The plain `<img>` node in the editor, with drag-to-resize. */
export const SizedImageEditNode = SizedImage.extend({
  addNodeView() {
    return ReactNodeViewRenderer(SizedImageEditComponent);
  },
});

function SizedImageEditComponent({
  node,
  selected,
  editor,
  getPos,
  updateAttributes,
}: ReactNodeViewProps) {
  const { src, alt, title, size, align } = node.attrs;
  return (
    <NodeViewWrapper data-drag-handle>
      <ResizableImageFrame
        size={parseImageWidth(size)}
        align={parseImageAlign(align)}
        selected={selected}
        onResize={(next) => resizeAndKeepSelected({ editor, getPos, updateAttributes }, next)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={src} alt={alt ?? undefined} title={title ?? undefined} />
      </ResizableImageFrame>
    </NodeViewWrapper>
  );
}
