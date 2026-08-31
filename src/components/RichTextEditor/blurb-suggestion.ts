import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import { exitSuggestion } from '@tiptap/suggestion';
import { BlurbList, type BlurbListRef } from '~/components/RichTextEditor/BlurbList';
import { updateSuggestionPosition } from '~/components/RichTextEditor/suggestion';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { insertBlurb } from '~/components/RichTextEditor/blurb.util';

/**
 * Its own key, and it has to be. `@tiptap/suggestion` defaults `pluginKey` to the shared
 * `SuggestionPluginKey`, which mentions (`suggestion.ts`) deliberately pins so `exitSuggestion()`
 * reaches its reducer — only one plugin can hold that. Sharing it is "Adding different instances
 * of a keyed plugin" at `EditorState.create`, i.e. every editor carrying both extensions throws on
 * mount rather than misbehaving subtly.
 */
export const BlurbSuggestionPluginKey = new PluginKey('blurbSuggestion');

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
  manage: () => void;
} {
  let component: ReactRenderer<BlurbListRef> | null = null;
  let latestProps: SuggestionProps<BlurbItem> | null = null;
  let outsideClickHandler: ((event: MouseEvent) => void) | null = null;

  /**
   * Opening the manager consumes nothing, so the `//sup` stays matched, the popover keeps drawing
   * over the modal, and the eventual insert lands after the literal trigger text.
   */
  const manage = () => {
    const props = latestProps;
    cleanup();
    if (props) props.editor.chain().focus().deleteRange(props.range).run();
    onManage?.();
  };

  const suggestion: Omit<SuggestionOptions<BlurbItem>, 'editor'> = {
    pluginKey: BlurbSuggestionPluginKey,
    // `//`, not `/` — a lone slash is common in prose. `allowSpaces` is false and `allowedPrefixes`
    // is left at the plugin's default, so the character before the match must be whitespace or the
    // start of the current text node. That is what keeps `https://` from opening the popover: its
    // slashes follow a `:`.
    char: '//',
    allowSpaces: false,
    allow: () => getEnabled(),
    items: ({ query }) => getItems(query),

    command: ({ editor, range, props }) => {
      insertBlurb(editor, props, range);
    },

    render: () => {
      return {
        onStart: (props) => {
          latestProps = props;
          component = new ReactRenderer(BlurbList, {
            props: { ...props, loading: getLoading(), onManage: manage },
            editor: props.editor,
          });
          if (!props.clientRect) return;
          const el = component.element as HTMLElement;
          el.style.position = 'absolute';
          el.style.zIndex = '300';
          document.body.appendChild(el);
          updateSuggestionPosition(props.editor, el);

          // `@tiptap/suggestion` 3.4.0 removed the built-in document mousedown handler that closed
          // the popover on an outside click. Restored here, as in `suggestion.ts` and
          // `sticker-suggestion.ts` — without it the `//` popover stays open over the page.
          //
          // Both calls are needed. `exitSuggestion` only flips the plugin's `active` flag; the
          // popover element is torn down by `cleanup`, which the plugin reaches through `onExit`.
          // Verified in a browser: `exitSuggestion` alone leaves the popover on screen.
          outsideClickHandler = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (component?.element.contains(target)) return;
            if (props.editor.view.dom.contains(target)) return;
            exitSuggestion(props.editor.view, BlurbSuggestionPluginKey);
            cleanup();
          };
          document.addEventListener('mousedown', outsideClickHandler);
        },

        onUpdate: (props) => {
          latestProps = props;
          if (!component) return;
          component.updateProps({ ...props, loading: getLoading(), onManage: manage });
          if (!props.clientRect) return;
          updateSuggestionPosition(props.editor, component.element as HTMLElement);
        },

        onKeyDown: (props) => {
          // 🔴 Escape is NOT handled here, deliberately. The plugin's own `handleKeyDown` treats a
          // truthy return as "the renderer dealt with it" and returns early — skipping the
          // `onExit` call that tears the popover down. Handling Escape here left it on screen no
          // matter what this returned. Falling through lets the plugin run its own path, which
          // calls `onExit` (-> cleanup) AND resets its state.
          if (props.event.key === 'Escape') return false;
          return component?.ref?.onKeyDown(props) ?? false;
        },

        onExit: () => {
          cleanup();
        },
      };
    },
  };

  function cleanup() {
    if (outsideClickHandler) {
      document.removeEventListener('mousedown', outsideClickHandler);
      outsideClickHandler = null;
    }
    if (!component) return;
    component.element.remove();
    component.destroy();
    component = null;
    latestProps = null;
  }

  const refresh = () => {
    if (!component || !latestProps) return;
    const items = getItems(latestProps.query);
    component.updateProps({ ...latestProps, items, loading: getLoading(), onManage: manage });
  };

  return { suggestion, refresh, manage };
}
