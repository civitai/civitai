import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { Sticker } from '~/components/Sticker/Sticker';
import { StickerNode } from '~/shared/tiptap/sticker.node';

/**
 * Editor-side sticker node: same schema as the shared `StickerNode`, but with a
 * React node view so authors see the sticker while editing rather than an empty
 * span.
 */
export const StickerEditNode = StickerNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(StickerEditComponent);
  },
});

function StickerEditComponent({ node }: ReactNodeViewProps<HTMLSpanElement>) {
  const { id } = node.attrs as { id: string };
  return (
    <NodeViewWrapper as="span" data-drag-handle style={{ display: 'inline' }}>
      <Sticker cosmeticId={Number(id)} />
    </NodeViewWrapper>
  );
}
