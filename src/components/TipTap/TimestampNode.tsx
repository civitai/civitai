import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { LocalTimestamp } from '~/components/LocalTimestamp/LocalTimestamp';
import { TimestampNode } from '~/shared/tiptap/timestamp.node';

/**
 * Editor-side timestamp node: same schema as the shared `TimestampNode`, but
 * with a React node view so authors see the rendered local time (as a chip)
 * while editing instead of the raw `<t:...>` tag.
 */
export const TimestampEditNode = TimestampNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TimestampEditComponent);
  },
});

function TimestampEditComponent({ node }: ReactNodeViewProps<HTMLSpanElement>) {
  const { value, style } = node.attrs as { value: string; style: string };
  return (
    <NodeViewWrapper as="span" data-drag-handle style={{ display: 'inline' }}>
      <LocalTimestamp value={value} style={style} />
    </NodeViewWrapper>
  );
}
