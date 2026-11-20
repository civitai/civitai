import { ActionIcon, ColorPicker, ColorSwatch, Group, SimpleGrid, TextInput } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconCheck, IconCircleOff, IconColorPicker, IconPalette } from '@tabler/icons-react';
import { useState } from 'react';
import { Popover } from '~/components/MantineOverlays';
import { CSS_COLOR } from '~/utils/html-sanitize-helpers';

const [HEX_COLOR] = CSS_COLOR;

/** A hex colour typed with or without `#`, or null when the sanitiser would strip it. */
export function parseHexColor(input: string) {
  const value = `#${input.trim().replace(/^#/, '')}`.toLowerCase();
  return HEX_COLOR.test(value) ? value : null;
}

// Mantine's RTE.ColorPicker has no text field, so this mirrors it (swatches + drag picker) and adds one.
export function TextColorControl({ colors }: { colors: readonly string[] }) {
  const { editor } = useRichTextEditorContext();
  const [opened, { open, close }] = useDisclosure(false);
  const [mode, setMode] = useState<'palette' | 'picker'>('palette');
  const [hex, setHex] = useState('');
  const [invalid, setInvalid] = useState(false);
  const current: string | undefined = editor?.getAttributes('textStyle').color;

  const apply = (color: string, keepOpen = false) => {
    editor?.chain().focus().setColor(color).run();
    if (!keepOpen) close();
  };
  const applyHex = () => {
    if (!hex.trim()) return close();
    const color = parseHexColor(hex);
    if (color) apply(color);
    else setInvalid(true);
  };

  return (
    <Popover
      opened={opened}
      onChange={(next) => !next && close()}
      withinPortal
      trapFocus
      position="bottom-start"
    >
      <Popover.Target>
        <RichTextEditor.Control
          aria-label="Text color"
          title="Text color"
          onClick={() => {
            if (opened) return close();
            setHex(current && parseHexColor(current) ? current : '');
            setInvalid(false);
            open();
          }}
        >
          <ColorSwatch color={current ?? 'var(--mantine-color-text)'} size={14} />
        </RichTextEditor.Control>
      </Popover.Target>
      <Popover.Dropdown>
        {mode === 'palette' ? (
          <SimpleGrid cols={7} spacing={2}>
            {colors.map((color) => (
              <ColorSwatch
                key={color}
                component="button"
                type="button"
                color={color}
                size={26}
                radius="xs"
                style={{ cursor: 'pointer' }}
                aria-label={`Set color ${color}`}
                title={color}
                onClick={() => apply(color)}
              />
            ))}
          </SimpleGrid>
        ) : (
          <ColorPicker
            format="hex"
            saturationLabel="Saturation and brightness"
            hueLabel="Hue"
            defaultValue={current && parseHexColor(current) ? current : undefined}
            onChange={(value) => {
              setHex(value);
              apply(value, true);
            }}
          />
        )}
        <Group gap="xs" mt="sm" wrap="nowrap">
          <TextInput
            aria-label="Hex color"
            placeholder="#ff8800"
            size="xs"
            w={120}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={hex}
            error={invalid}
            onChange={(e) => {
              setHex(e.currentTarget.value);
              setInvalid(false);
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              applyHex();
            }}
          />
          <ActionIcon
            variant="default"
            onClick={applyHex}
            aria-label="Apply hex color"
            title="Apply hex color"
          >
            <IconCheck size={16} />
          </ActionIcon>
          <ActionIcon
            variant="default"
            onClick={() => {
              editor?.chain().focus().unsetColor().run();
              close();
            }}
            aria-label="Clear color"
            title="Clear color"
          >
            <IconCircleOff size={16} />
          </ActionIcon>
          <ActionIcon
            variant="default"
            onClick={() => setMode(mode === 'palette' ? 'picker' : 'palette')}
            aria-label={mode === 'palette' ? 'Color picker' : 'Color palette'}
            title={mode === 'palette' ? 'Color picker' : 'Color palette'}
          >
            {mode === 'palette' ? <IconColorPicker size={16} /> : <IconPalette size={16} />}
          </ActionIcon>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}
