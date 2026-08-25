import { IconRepeat, IconUnlink } from '@tabler/icons-react';
import type { ReactNodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import clsx from 'clsx';
import { createContext, useContext } from 'react';
import { createBlurbSuggestion } from '~/components/RichTextEditor/blurb-suggestion';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { blurbPreview, matchBlurbs } from '~/components/RichTextEditor/blurb.util';
import type { BlurbAttrs } from '~/shared/tiptap/blurb.node';
import { BlurbNode } from '~/shared/tiptap/blurb.node';

export type BlurbNodeStorage = {
  /**
   * The caller's blurbs, kept current by `RichTextEditorComponent`. Held in per-editor storage
   * rather than extension options so a list arriving asynchronously doesn't change the extension
   * array and rebuild the editor under someone who is mid-sentence.
   */
  available: BlurbItem[];
  loading: boolean;
  /** Feature-flag state for the `//` picker; the node itself is always registered. */
  enabled: boolean;
  onManage?: () => void;
  /** Pushes a later-arriving list into an already-open suggestion popover. */
  refresh?: () => void;
};

declare module '@tiptap/core' {
  interface Storage {
    blurb: BlurbNodeStorage;
  }
}

type BlurbEditorState = {
  blurbs: BlurbItem[];
  /**
   * The list has resolved at least once. Until it has, no chip is treated as orphaned — a
   * pending query would otherwise flag every chip in the document as deleted.
   */
  resolved: boolean;
};

const BlurbEditorContext = createContext<BlurbEditorState | null>(null);
export const BlurbEditorProvider = BlurbEditorContext.Provider;

/**
 * Editor-side blurb node: same schema as the shared `BlurbNode`, plus the chip node view and the
 * `//` picker. Registering the node view here rather than on the shared node keeps the published
 * render path — which must show ordinary text — untouched.
 */
export const BlurbEditNode = BlurbNode.extend<unknown, BlurbNodeStorage>({
  addStorage() {
    return { available: [], loading: false, enabled: false };
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlurbChip);
  },

  addProseMirrorPlugins() {
    const { suggestion, refresh } = createBlurbSuggestion({
      getItems: (query) => matchBlurbs(this.storage.available, query),
      getLoading: () => this.storage.loading,
      getEnabled: () => this.storage.enabled,
      onManage: () => this.storage.onManage?.(),
    });
    this.storage.refresh = refresh;

    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});

function BlurbChip({ node }: ReactNodeViewProps<HTMLSpanElement>) {
  const { id, text } = node.attrs as BlurbAttrs;
  const state = useContext(BlurbEditorContext);
  const orphan = !!state?.resolved && !state.blurbs.some((blurb) => blurb.id === id);

  return (
    <NodeViewWrapper
      as="span"
      data-drag-handle
      className={clsx(
        'mx-px inline-flex min-h-6 items-center gap-1.5 rounded-sm border border-solid px-2 py-0.5 align-middle text-sm',
        orphan
          ? 'border-red-8 bg-red-1 text-red-8 dark:bg-red-8/20 dark:text-red-2'
          : 'border-blue-8 bg-blue-1 text-blue-8 dark:bg-blue-8/20 dark:text-blue-4'
      )}
    >
      {orphan ? (
        <IconUnlink size={13} stroke={1.5} className="shrink-0" />
      ) : (
        <IconRepeat size={13} stroke={1.5} className="shrink-0" />
      )}
      {blurbPreview(text)}
    </NodeViewWrapper>
  );
}
