import { Menu } from '~/components/MantineOverlays';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import {
  IconAlignCenter,
  IconAlignLeft,
  IconAlignRight,
  IconChevronDown,
} from '@tabler/icons-react';
import type { TextAlignment } from '~/shared/tiptap/text-align';

const OPTIONS = [
  { value: 'left', label: 'Left', Icon: IconAlignLeft },
  { value: 'center', label: 'Center', Icon: IconAlignCenter },
  { value: 'right', label: 'Right', Icon: IconAlignRight },
] satisfies { value: TextAlignment; label: string; Icon: typeof IconAlignLeft }[];

export function TextAlignControl() {
  const { editor } = useRichTextEditorContext();
  // Unaligned blocks render left, so left is what the button shows until another is chosen.
  const current = OPTIONS.find((o) => editor?.isActive({ textAlign: o.value })) ?? OPTIONS[0];

  return (
    <Menu withinPortal position="bottom-start" shadow="md">
      <Menu.Target>
        <RichTextEditor.Control
          aria-label={`Text alignment: ${current.label}`}
          title="Text alignment"
          w="auto"
          px={4}
        >
          <current.Icon size={16} stroke={1.5} />
          <IconChevronDown size={10} stroke={1.5} />
        </RichTextEditor.Control>
      </Menu.Target>
      <Menu.Dropdown>
        {OPTIONS.map(({ value, label, Icon }) => {
          const active = value === current.value;
          return (
            <Menu.Item
              key={value}
              data-active={active || undefined}
              bg={active ? 'var(--mantine-primary-color-light)' : undefined}
              leftSection={<Icon size={16} stroke={1.5} />}
              onClick={() => {
                const chain = editor?.chain().focus();
                // Left is the unaligned state, so it clears the attribute instead of writing one.
                (value === 'left' ? chain?.unsetTextAlign() : chain?.setTextAlign(value))?.run();
              }}
            >
              {label}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}
