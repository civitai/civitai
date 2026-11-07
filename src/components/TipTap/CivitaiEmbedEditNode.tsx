import { CloseButton, Text } from '@mantine/core';
import { IconPhoto, IconCube } from '@tabler/icons-react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import clsx from 'clsx';
import { CivitaiEmbedNode } from '~/shared/tiptap/civitai-embed.node';
import type { CivitaiEmbedItem } from '~/shared/tiptap/civitai-embed.utils';
import { getCivitaiEmbedHref, toCivitaiEmbedItem } from '~/shared/tiptap/civitai-embed.utils';

// The editor shows what will load, not the cards themselves: those depend on each reader's
// browsing settings, so the author's own view would be misleading.
function CivitaiEmbedChips({ node, selected, deleteNode, editor }: ReactNodeViewProps) {
  const items = ((node.attrs.items ?? []) as unknown[])
    .map(toCivitaiEmbedItem)
    .filter((item): item is CivitaiEmbedItem => !!item);

  return (
    <NodeViewWrapper
      data-type="civitaiEmbed"
      className={clsx(
        'my-2 flex flex-wrap gap-2 rounded-md border border-dashed p-2',
        selected ? 'border-blue-5' : 'border-gray-4 dark:border-dark-3'
      )}
    >
      {items.map((item, index) => {
        const Icon = item.type === 'model' ? IconCube : IconPhoto;
        return (
          <div
            key={`${item.type}-${item.id}-${index}`}
            className="flex items-center gap-1 rounded bg-gray-1 px-2 py-1 dark:bg-dark-5"
          >
            <Icon size={14} />
            <Text size="xs">
              {item.type === 'model' ? 'Model card' : 'Image card'} · {getCivitaiEmbedHref(item)}
            </Text>
          </div>
        );
      })}
      {editor.isEditable && (
        <CloseButton size="sm" aria-label="Remove cards" onClick={deleteNode} className="ml-auto" />
      )}
    </NodeViewWrapper>
  );
}

export const CivitaiEmbedEditNode = CivitaiEmbedNode.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CivitaiEmbedChips);
  },
});
