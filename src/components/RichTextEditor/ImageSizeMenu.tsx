import { ActionIcon, Group, SegmentedControl } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconArrowsHorizontal,
  IconFloatLeft,
  IconFloatRight,
} from '@tabler/icons-react';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import type { ImageAlign } from '~/shared/tiptap/image-width';
import { parseImageAlign, parseImageWidth } from '~/shared/tiptap/image-width';
import classes from './RichTextEditorComponent.module.scss';

const ALIGN_OPTIONS: { label: string; value: ImageAlign; Icon: typeof IconAlignLeft }[] = [
  { label: 'Align left', value: 'left', Icon: IconAlignLeft },
  { label: 'Center', value: 'center', Icon: IconAlignCenter },
  { label: 'Align right', value: 'right', Icon: IconAlignRight },
  { label: 'Float left, text wraps', value: 'float-left', Icon: IconFloatLeft },
  { label: 'Float right, text wraps', value: 'float-right', Icon: IconFloatRight },
];

export function getSelectedImage(state: EditorState) {
  const { selection } = state;
  if (!(selection instanceof NodeSelection)) return null;
  const { node } = selection;
  if (node.type.name === 'image') return node;
  if (node.type.name === 'media' && node.attrs.type === 'image') return node;
  return null;
}

/** Placement for a selected image. Its width is set by dragging the image's edges. */
export function ImageSizeMenu({ editor }: { editor: Editor }) {
  const align = useEditorState({
    editor,
    selector: ({ editor }) => {
      const node = editor ? getSelectedImage(editor.state) : null;
      if (!node) return null;
      // What the image shows with no align set: a sized image centers, an unsized one starts the line.
      return (
        parseImageAlign(node.attrs.align) ?? (parseImageWidth(node.attrs.size) ? 'center' : 'left')
      );
    },
  });

  const update = (attrs: Record<string, unknown>) => {
    const node = getSelectedImage(editor.state);
    if (!node) return;
    const { from } = editor.state.selection;
    editor
      .chain()
      .focus()
      .updateAttributes(node.type.name, attrs)
      // Replacing a leaf node turns its selection into text and closes this menu; reselect it.
      .setNodeSelection(from)
      .run();
  };

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="imageSizeMenu"
      shouldShow={({ state }) => !!getSelectedImage(state)}
      className={classes.bubbleTooltip}
    >
      <Group gap={4} wrap="nowrap">
        <SegmentedControl
          size="xs"
          aria-label="Image alignment"
          value={align ?? 'left'}
          onChange={(value) => update({ align: value })}
          data={ALIGN_OPTIONS.map(({ label, value, Icon }) => ({
            value,
            label: (
              <Tooltip label={label} withinPortal>
                <span aria-label={label} className="flex">
                  <Icon size={16} />
                </span>
              </Tooltip>
            ),
          }))}
        />
        <Tooltip label="Full width" withinPortal>
          <ActionIcon
            variant="default"
            aria-label="Full width"
            onClick={() => update({ size: null, align: null })}
          >
            <IconArrowsHorizontal size={16} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </BubbleMenu>
  );
}
