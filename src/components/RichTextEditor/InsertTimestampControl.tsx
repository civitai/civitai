import { Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import type { RichTextEditorControlProps } from '@mantine/tiptap';
import { RichTextEditor, useRichTextEditorContext } from '@mantine/tiptap';
import { IconClockHour4 } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { DiscordTimestampStyle } from '~/utils/timestamp-helpers';
import {
  DEFAULT_TIMESTAMP_STYLE,
  DISCORD_TIMESTAMP_STYLES,
  formatDiscordTimestamp,
} from '~/utils/timestamp-helpers';

const controlTitle = 'Insert local timestamp';

const STYLE_LABELS: Record<DiscordTimestampStyle, string> = {
  t: 'Short time',
  T: 'Long time',
  d: 'Short date',
  D: 'Long date',
  f: 'Short date/time',
  F: 'Long date/time',
  R: 'Relative',
};

export function InsertTimestampControl(props: Props) {
  const { editor } = useRichTextEditorContext();

  const handleClick = () => {
    dialogStore.trigger({
      component: InsertTimestampModal,
      props: { editor },
    });
  };

  return (
    <RichTextEditor.Control
      {...props}
      onClick={handleClick}
      aria-label={controlTitle}
      title={controlTitle}
    >
      <IconClockHour4 size={16} stroke={1.5} />
    </RichTextEditor.Control>
  );
}

type Props = Omit<RichTextEditorControlProps, 'icon' | 'onClick'>;

function InsertTimestampModal({ editor }: { editor: Editor | null }) {
  const dialog = useDialogContext();
  const [date, setDate] = useState<Date>(() => new Date());
  const [style, setStyle] = useState<DiscordTimestampStyle>(DEFAULT_TIMESTAMP_STYLE);

  const styleOptions = useMemo(
    () =>
      DISCORD_TIMESTAMP_STYLES.map((value) => ({
        value,
        label: `${STYLE_LABELS[value]} — ${formatDiscordTimestamp(
          Math.floor(date.getTime() / 1000),
          value
        )}`,
      })),
    [date]
  );

  const handleInsert = () => {
    if (editor && date) {
      editor.commands.setTimestamp({ value: Math.floor(date.getTime() / 1000), style });
    }
    dialog.onClose();
  };

  return (
    <Modal title={controlTitle} {...dialog}>
      <Stack>
        <Text size="sm" c="dimmed">
          Pick a moment and it renders in each viewer&apos;s local timezone.
        </Text>
        <DateTimePicker
          label="Date & time (your local time)"
          value={date}
          onChange={(value) => value && setDate(new Date(value))}
          popoverProps={{ withinPortal: true }}
          clearable={false}
        />
        <Select
          label="Format"
          data={styleOptions}
          value={style}
          onChange={(value) => value && setStyle(value as DiscordTimestampStyle)}
          comboboxProps={{ withinPortal: true }}
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={() => dialog.onClose()}>
            Cancel
          </Button>
          <Button onClick={handleInsert} disabled={!date || !editor}>
            Insert
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
