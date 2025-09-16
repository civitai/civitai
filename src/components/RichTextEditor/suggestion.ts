import type { SuggestionOptions } from '@tiptap/suggestion';
import { computePosition, flip, shift } from '@floating-ui/dom';
import { posToDOMRect, ReactRenderer } from '@tiptap/react';

import type { MentionListRef } from '~/components/RichTextEditor/MentionList';
import { MentionList } from '~/components/RichTextEditor/MentionList';

type Options = { defaultSuggestions?: Array<{ id: number; label: string }> };

export function getSuggestions(options?: Options) {
  const { defaultSuggestions = [] } = options || {};

  const suggestion: Omit<SuggestionOptions, 'editor'> = {
    items: ({ query }) =>
      defaultSuggestions
        .filter((suggestion) => suggestion.label.toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, 5),
    render: () => {
      let component: ReactRenderer<MentionListRef>;
      // let popup: TippyInstance[] | undefined;

      return {
        onStart: (props) => {
          component = new ReactRenderer(MentionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;
          (component.element as HTMLElement).style.position = 'absolute';
          (component.element as HTMLElement).style.zIndex = '300';

          document.body.appendChild(component.element);

          updatePosition(props.editor, component.element);
        },

        onUpdate(props) {
          component.updateProps(props);
          if (!props.clientRect) return;

          updatePosition(props.editor, component.element);
        },

        onKeyDown(props) {
          if (props.event.key === 'Escape') {
            component.destroy();

            return true;
          }

          return component.ref?.onKeyDown(props) ?? true;
        },

        onExit() {
          component.element.remove();
          component.destroy();
        },
      };
    },
  };

  return suggestion;
}

const updatePosition = (editor: any, element: any) => {
  const virtualElement = {
    getBoundingClientRect: () =>
      posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
  };

  computePosition(virtualElement, element, {
    placement: 'bottom-start',
    strategy: 'absolute',
    middleware: [shift(), flip()],
  }).then(({ x, y, strategy }) => {
    element.style.width = 'max-content';
    element.style.position = strategy;
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
};
