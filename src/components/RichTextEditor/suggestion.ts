import { ReactRenderer } from '@tiptap/react';
import { SuggestionOptions } from '@tiptap/suggestion';
import tippy, { Instance as TippyInstance } from 'tippy.js';

import { MentionListRef, MentionList } from '~/components/RichTextEditor/MentionList';

type Options = { defaultSuggestions?: Array<{ id: number; label: string }> };

export function getSuggestions(options?: Options) {
  const { defaultSuggestions = [] } = options || {};

  const suggestion: Omit<SuggestionOptions, 'editor'> = {
    items: ({ query }) =>
      defaultSuggestions
        .filter((suggestion) => suggestion.label.toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, 5),
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
