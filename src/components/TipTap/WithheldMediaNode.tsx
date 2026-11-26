import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { WithheldMediaNode } from '~/shared/tiptap/withheld-media.node';

/** In the editor, a body image this editor may not see shows as a neutral block. */
export const WithheldMediaEditNode = WithheldMediaNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(WithheldMediaEditComponent);
  },
});

function WithheldMediaEditComponent() {
  return (
    <NodeViewWrapper
      as="span"
      className="inline-block rounded border border-dashed border-gray-4 px-3 py-6 text-sm text-dimmed dark:border-dark-4"
    >
      Image hidden
    </NodeViewWrapper>
  );
}
