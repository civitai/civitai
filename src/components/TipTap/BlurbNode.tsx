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

function BlurbChip({ node, selected }: ReactNodeViewProps<HTMLDivElement>) {
  const { id, text } = node.attrs as BlurbAttrs;
  const state = useContext(BlurbEditorContext);
  const blurb = state?.blurbs.find((x) => x.id === id);
  const orphan = !!state?.resolved && !blurb;

  // The name, so the editor reads as a reference rather than as the words themselves — the point
  // being that this text is not editable here. It falls back to the words while the list is still
  // loading, and for an orphan, which by definition has no name left to show.
  const label = blurb?.name ?? blurbPreview(text);

  return (
    <NodeViewWrapper
      as="div"
      data-drag-handle
      className={clsx(
        'my-1 flex min-h-8 cursor-pointer items-center gap-1.5 rounded-sm border border-solid px-2.5 py-1 text-sm',
        orphan
          ? 'border-red-8 bg-red-1 text-red-8 dark:bg-red-8/20 dark:text-red-2'
          : 'border-blue-8 bg-blue-1 text-blue-8 dark:bg-blue-8/20 dark:text-blue-4',
        // An atom node has no caret of its own, so a plain border leaves selected and unselected
        // looking alike. The ring is offset so it reads outside the chip's own border.
        selected && 'ring-2 ring-offset-1 ring-offset-white dark:ring-offset-dark-7',
        selected && (orphan ? 'ring-red-6' : 'ring-blue-5')
      )}
    >
      {orphan ? (
        <IconUnlink size={14} stroke={1.5} className="shrink-0" />
      ) : (
        <IconRepeat size={14} stroke={1.5} className="shrink-0" />
      )}
      <span className="truncate font-semibold">{label}</span>
    </NodeViewWrapper>
  );
}
