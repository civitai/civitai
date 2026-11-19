import { SegmentedControl } from '@mantine/core';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { ImageWidth } from '~/shared/tiptap/image-width';
import { parseImageWidth } from '~/shared/tiptap/image-width';
import classes from './RichTextEditorComponent.module.scss';

const SIZE_OPTIONS: { label: string; value: ImageWidth }[] = [
  { label: 'S', value: '33' },
  { label: 'M', value: '50' },
  { label: 'L', value: '75' },
  { label: 'Full', value: '100' },
];

export function getSelectedImage(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  const { node } = selection;
  if (node.type.name === 'image') return node;
  if (node.type.name === 'media' && node.attrs.type === 'image') return node;
  return null;
}

export function ImageSizeMenu({ editor }: { editor: Editor }) {
  const size = useEditorState({
    editor,
    selector: ({ editor }) => {
      const node = editor ? getSelectedImage(editor.state) : null;
      return node ? parseImageWidth(node.attrs.size) ?? '100' : null;
    },
  });

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="imageSizeMenu"
      shouldShow={({ state }) => !!getSelectedImage(state)}
      className={classes.bubbleTooltip}
    >
      <SegmentedControl
        size="xs"
        aria-label="Image size"
        data={SIZE_OPTIONS}
        value={size ?? '100'}
        onChange={(value) => {
          const node = getSelectedImage(editor.state);
          if (!node) return;
          const { from } = editor.state.selection;
          editor
            .chain()
            .focus()
            .updateAttributes(node.type.name, { size: value === '100' ? null : value })
            // Replacing a leaf node turns its selection into text and closes this menu; reselect it.
            .setNodeSelection(from)
            .run();
        }}
      />
    </BubbleMenu>
  );
}
