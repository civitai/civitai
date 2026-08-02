import { PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions } from '@tiptap/suggestion';
import { exitSuggestion } from '@tiptap/suggestion';
import type { StickerSuggestionListRef } from '~/components/RichTextEditor/StickerSuggestionList';
import { StickerSuggestionList } from '~/components/RichTextEditor/StickerSuggestionList';
import { updateSuggestionPosition } from '~/components/RichTextEditor/suggestion';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';

/**
 * Its own key, and it has to be. Two suggestion plugins sharing one `PluginKey`
 * is "Adding different instances of a keyed plugin" at `EditorState.create` — a
 * crash on every editor carrying both, not a subtle conflict. Mentions
 * (`suggestion.ts`) pins the package default `SuggestionPluginKey` so that
 * `exitSuggestion()`, which defaults to that key, reaches its reducer; only one
 * plugin can do that. The escape hatch for everyone else is the second argument
 * of `exitSuggestion(view, pluginKeyRef)`, used below.
 */
export const StickerSuggestionPluginKey = new PluginKey('stickerSuggestion');

/** `:` appears in times, URLs and emoticons — two characters keeps it quiet. */
const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 8;

export function getStickerSuggestions(getAvailable: () => ResolvedSticker[]) {
  const suggestion: Omit<SuggestionOptions<ResolvedSticker>, 'editor'> = {
    pluginKey: StickerSuggestionPluginKey,
    char: ':',
    allowSpaces: false,
    // Without this the trigger fires on the `:` in `https://` and `12:30`.
    allowedPrefixes: [' ', '\n'],
    items: ({ query }) => {
      if (query.length < MIN_QUERY_LENGTH) return [];
      const needle = query.toLowerCase();
      return getAvailable()
        .filter((x) => x.slug.includes(needle) || x.name.toLowerCase().includes(needle))
        .slice(0, MAX_RESULTS);
    },
    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setSticker({ id: props.id, slug: props.slug })
        .run();
    },
    render: () => {
      let component: ReactRenderer<StickerSuggestionListRef>;
      let outsideClickHandler: ((event: MouseEvent) => void) | null = null;

      return {
        onStart: (props) => {
          component = new ReactRenderer(StickerSuggestionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;
          (component.element as HTMLElement).style.position = 'absolute';
          (component.element as HTMLElement).style.zIndex = '300';
          document.body.appendChild(component.element);
          updateSuggestionPosition(props.editor, component.element);

          outsideClickHandler = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;
            if (component.element.contains(target)) return;
            if (props.editor.view.dom.contains(target)) return;
            exitSuggestion(props.editor.view, StickerSuggestionPluginKey);
          };
          document.addEventListener('mousedown', outsideClickHandler);
        },
        onUpdate(props) {
          component.updateProps(props);
          if (!props.clientRect) return;
          updateSuggestionPosition(props.editor, component.element);
        },
        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            exitSuggestion(props.view, StickerSuggestionPluginKey);
            return true;
          }
          return component.ref?.onKeyDown(props) ?? false;
        },
        onExit() {
          if (outsideClickHandler) {
            document.removeEventListener('mousedown', outsideClickHandler);
            outsideClickHandler = null;
          }
          component.element.remove();
          component.destroy();
        },
      };
    },
  };

  return suggestion;
}
