import { computePosition, flip, shift } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import { posToDOMRect, ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { BlurbList, type BlurbListRef } from '~/components/RichTextEditor/BlurbList';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';

/**
 * `getItems` is a function rather than a static array so the editor wrapper can reach a live query
 * result without rebuilding the extension on every render. The plugin only re-evaluates `items` on
 * a query or selection change, so `refresh()` exists to push a later-arriving list into an already
 * open popover.
 */
export function createBlurbSuggestion({
  getItems,
  getLoading = () => false,
  getEnabled = () => true,
  onManage,
}: {
  getItems: (query: string) => BlurbItem[];
  getLoading?: () => boolean;
  /**
   * Read per match rather than baked into the extension options: the feature flag resolves after
   * mount, and rebuilding the extension array would throw away whatever the user had typed.
   */
  getEnabled?: () => boolean;
  onManage?: () => void;
}): {
  suggestion: Omit<SuggestionOptions<BlurbItem>, 'editor'>;
  refresh: () => void;
} {
  let component: ReactRenderer<BlurbListRef> | null = null;
  let latestProps: SuggestionProps<BlurbItem> | null = null;

  const suggestion: Omit<SuggestionOptions<BlurbItem>, 'editor'> = {
    // `//`, not `/` — a lone slash is common in prose. With `allowSpaces` false and the plugin's
    // default `allowedPrefixes` (start of input or whitespace), `https://` does not open the
    // popover because the slashes follow a `:`.
    char: '//',
    allowSpaces: false,
    allow: () => getEnabled(),
    items: ({ query }) => getItems(query),

    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent({ type: 'blurb', attrs: { id: props.id, text: props.content } })
        .run();
    },

    render: () => {
      return {
        onStart: (props) => {
          latestProps = props;
          component = new ReactRenderer(BlurbList, {
            props: { ...props, loading: getLoading(), onManage },
            editor: props.editor,
          });
          if (!props.clientRect) return;
          const el = component.element as HTMLElement;
          el.style.position = 'absolute';
          el.style.zIndex = '300';
          document.body.appendChild(el);
          updatePosition(props.editor, el);
        },

        onUpdate: (props) => {
          latestProps = props;
          if (!component) return;
          component.updateProps({ ...props, loading: getLoading(), onManage });
          if (!props.clientRect) return;
          updatePosition(props.editor, component.element as HTMLElement);
        },

        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            cleanup();
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },

        onExit: () => {
          cleanup();
        },
      };
    },
  };

  function cleanup() {
    if (!component) return;
    component.element.remove();
    component.destroy();
    component = null;
    latestProps = null;
  }

  const refresh = () => {
    if (!component || !latestProps) return;
    const items = getItems(latestProps.query);
    component.updateProps({ ...latestProps, items, loading: getLoading(), onManage });
  };

  return { suggestion, refresh };
}

function updatePosition(editor: Editor, element: HTMLElement) {
  const virtualElement = {
    getBoundingClientRect: () =>
      posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
  };
  computePosition(virtualElement, element, {
    placement: 'bottom-start',
    strategy: 'absolute',
    middleware: [shift({ padding: 8 }), flip()],
  }).then(({ x, y, strategy }) => {
    element.style.position = strategy;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
}
