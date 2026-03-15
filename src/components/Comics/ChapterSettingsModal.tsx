import { Button, Group, Modal, NumberInput, Stack, Switch, Text, TextInput } from '@mantine/core';
import { IconLock, IconTrash } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ComicChapterStatus } from '~/shared/utils/prisma/enums';

interface ChapterSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  chapter: {
    position: number;
    name: string;
    status: string;
    earlyAccessConfig: { buzzPrice: number; timeframe: number } | null;
  } | null;
  canDelete: boolean;
  onSave: (data: {
    position: number;
    name: string;
    eaConfig: { buzzPrice: number; timeframe: number } | null;
  }) => void;
  onDelete: (position: number, name: string) => void;
  isSaving: boolean;
  isDeleting: boolean;
}

export function ChapterSettingsModal({
  opened,
  onClose,
  chapter,
  canDelete,
  onSave,
  onDelete,
  isSaving,
  isDeleting,
}: ChapterSettingsModalProps) {
  const [chapterSettingsName, setChapterSettingsName] = useState('');
  const [chapterSettingsEaEnabled, setChapterSettingsEaEnabled] = useState(false);
  const [chapterSettingsEaBuzzPrice, setChapterSettingsEaBuzzPrice] = useState<number | string>(100);
  const [chapterSettingsEaTimeframe, setChapterSettingsEaTimeframe] = useState<number | string>(7);

  // Initialize state from chapter when modal opens
  useEffect(() => {
    if (opened && chapter) {
      setChapterSettingsName(chapter.name);
      setChapterSettingsEaEnabled(chapter.earlyAccessConfig != null);
      setChapterSettingsEaBuzzPrice(chapter.earlyAccessConfig?.buzzPrice ?? 100);
      setChapterSettingsEaTimeframe(chapter.earlyAccessConfig?.timeframe ?? 7);
    }
  }, [opened, chapter]);

  if (!chapter) return null;

  const isPublished = chapter.status === ComicChapterStatus.Published;
  const currentEaConfig = chapter.earlyAccessConfig;

  const handleSave = () => {
    onSave({
      position: chapter.position,
      name: chapterSettingsName.trim(),
      eaConfig: chapterSettingsEaEnabled
        ? {
            buzzPrice: Number(chapterSettingsEaBuzzPrice),
            timeframe: Number(chapterSettingsEaTimeframe),
          }
        : null,
    });
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Chapter Settings" size="sm">
      <Stack gap="md">
        <TextInput
          label="Chapter Name"
          value={chapterSettingsName}
          onChange={(e) => setChapterSettingsName(e.currentTarget.value)}
        />

        {isPublished && (
          <>
            <Switch
              label="Early Access"
              description="Require Buzz payment to read this chapter"
              checked={chapterSettingsEaEnabled}
              onChange={(e) => setChapterSettingsEaEnabled(e.currentTarget.checked)}
            />

            {chapterSettingsEaEnabled && (
              <>
                <NumberInput
                  label="Buzz Price"
                  description={
                    currentEaConfig
                      ? `Current: ${currentEaConfig.buzzPrice} Buzz (can only reduce)`
                      : 'Amount of Buzz readers must pay'
                  }
                  value={chapterSettingsEaBuzzPrice}
                  onChange={(val) => setChapterSettingsEaBuzzPrice(val)}
                  min={1}
                  max={currentEaConfig ? Math.min(currentEaConfig.buzzPrice, 10000) : 10000}
                  leftSection={<IconLock size={16} />}
                />
                <NumberInput
                  label="Early Access Period (days)"
                  description={
                    currentEaConfig
                      ? `Current: ${currentEaConfig.timeframe} days (can only reduce)`
                      : 'After this many days the chapter becomes free'
                  }
                  value={chapterSettingsEaTimeframe}
                  onChange={(val) => setChapterSettingsEaTimeframe(val)}
                  min={1}
                  max={currentEaConfig ? Math.min(currentEaConfig.timeframe, 30) : 30}
                />
              </>
            )}
          </>
        )}

        <Group justify="space-between">
          {canDelete ? (
            <Button
              variant="subtle"
              color="red"
              size="xs"
              leftSection={<IconTrash size={14} />}
              loading={isDeleting}
              onClick={() => {
                onClose();
                onDelete(chapter.position, chapter.name);
              }}
            >
              Delete
            </Button>
          ) : (
            <div />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={isSaving}
              disabled={!chapterSettingsName.trim()}
            >
              Save
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
