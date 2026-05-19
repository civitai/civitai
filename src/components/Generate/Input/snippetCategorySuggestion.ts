import { computePosition, flip, shift } from '@floating-ui/dom';
import { posToDOMRect, ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import type { Editor } from '@tiptap/react';
import {
  SnippetCategoryList,
  type SnippetCategoryItem,
  type SnippetCategoryListRef,
} from './SnippetCategoryList';

/**
 * Build a SuggestionOptions for the SnippetCategory Tiptap node, configured
 * to pop on `#` and show a category picker.
 *
 * `getItems` is a function rather than a static array so the editor wrapper
 * can reach into a live store / query result without rebuilding the
 * extension on every render. The popover calls `getItems(query)` whenever
 * the user's typing changes; filtering / ordering / capping is the caller's
 * responsibility — we forward the filtered list straight to the renderer.
 *
 * `getLoading` is optional and reports whether the underlying category
 * source is still being fetched. The flag is merged into the renderer's
 * props so the popover can render a loading state when no items have
 * arrived yet. The Tiptap suggestion plugin only re-evaluates `items` on
 * query/selection change, so loading-state transitions that happen while
 * the popover sits idle won't refresh on their own — callers can invoke
 * the returned `refresh()` to push a fresh `loading` value into the active
 * renderer without waiting for the user to type.
 */
export function createSnippetCategorySuggestion(
  getItems: (query: string) => SnippetCategoryItem[],
  getLoading: () => boolean = () => false
): {
  suggestion: Omit<SuggestionOptions<SnippetCategoryItem>, 'editor'>;
  refresh: () => void;
} {
  let component: ReactRenderer<SnippetCategoryListRef> | null = null;
  let latestProps: SuggestionProps<SnippetCategoryItem> | null = null;

  const suggestion: Omit<SuggestionOptions<SnippetCategoryItem>, 'editor'> = {
    char: '#',
    // Allow the suggestion to fire when `#` is typed at the start of input
    // OR after whitespace. Don't trigger when `#` is buried inside a word
    // (e.g. user types `foo#bar` — that's not a snippet ref start).
    allowSpaces: false,
    items: ({ query }) => getItems(query),
    render: () => {
      return {
        onStart: (props) => {
          latestProps = props;
          component = new ReactRenderer(SnippetCategoryList, {
            props: { ...props, loading: getLoading() },
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
          component.updateProps({ ...props, loading: getLoading() });
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
    // Re-evaluate `items` against the latest query so additions/removals
    // (set added → categories grew, set removed → categories shrank) land
    // in the open popover instead of waiting for the next keystroke.
    const items = getItems(latestProps.query);
    component.updateProps({ ...latestProps, items, loading: getLoading() });
  };

  return { suggestion, refresh };
}

/**
 * Floating-UI placement against the current selection — same pattern the
 * RichTextEditor's mention suggestion uses. Bottom-start with flip+shift
 * so the popover lands under the caret and keeps inside the viewport on
 * narrow forms.
 */
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
    element.style.width = 'max-content';
    element.style.position = strategy;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
}
