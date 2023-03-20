import { ReactRenderer } from '@tiptap/react';
import { SuggestionOptions } from '@tiptap/suggestion';
import tippy, { Instance as TippyInstance } from 'tippy.js';

import { MentionListRef, MentionList } from '~/components/RichTextEditor/MentionList';
import { trpcFetch } from '~/libs/trpc-fetch';

type Options = { defaultSuggestions?: Array<{ id: number; label: string }> };

export function getResourceSuggestion(options?: Options) {
  const { defaultSuggestions = [] } = options || {};
  const suggestion: Omit<SuggestionOptions, 'editor'> = {
    char: '+',
    items: async ({ query }) => {
      if (query.length <= 1) return defaultSuggestions;
      console.log('mention resource', query);
      try {
        const { items } = await trpcFetch.model.getAllPagedSimple.query({
          query,
          limit: 5,
        });
        console.log(items);
        if (!items) return defaultSuggestions;

        return items.map(({ id, name }) => ({ id, label: name }));
      } catch (error) {
        console.error(error);
        return [];
      }
    },
    render: () => {
      let component: ReactRenderer<MentionListRef> | undefined;
      let popup: TippyInstance[] | undefined;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;

          popup = tippy('body', {
            getReferenceClientRect: props.clientRect as () => DOMRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
          });
        },

        onUpdate(props) {
          component?.updateProps(props);
          if (!props.clientRect) return;

          popup?.[0].setProps({
            getReferenceClientRect: props.clientRect as () => DOMRect,
          });
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            popup?.[0].hide();
            return true;
          }
          if (!component?.ref) return false;

          return component?.ref.onKeyDown(props);
        },

        onExit() {
          popup?.[0].destroy();
          component?.destroy();
        },
      };
    },
  };

  return suggestion;
}
