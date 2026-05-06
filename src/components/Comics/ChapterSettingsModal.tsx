import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { IconLock, IconTrash } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { ComicChapterStatus } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { EARLY_ACCESS_CONFIG } from '~/server/common/constants';
import { getMaxEarlyAccessDays } from '~/server/utils/early-access-helpers';

const MIN_BUZZ_PRICE = 100;

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
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // Score-based gate. The user can NEVER raise an existing config (the
  // server forbids it on update), so the relevant cap is `min(maxDays,
  // currentTimeframe)` when EA is already on, and `maxDays` for first-time
  // setup.
  const maxDays = getMaxEarlyAccessDays({ userMeta: currentUser?.meta, features });

  const [chapterSettingsName, setChapterSettingsName] = useState('');
  const [chapterSettingsEaEnabled, setChapterSettingsEaEnabled] = useState(false);
  const [chapterSettingsEaBuzzPrice, setChapterSettingsEaBuzzPrice] = useState<number | string>(
    MIN_BUZZ_PRICE
  );
  const [chapterSettingsEaTimeframe, setChapterSettingsEaTimeframe] = useState<number>(
    EARLY_ACCESS_CONFIG.timeframeValues[0]
  );

  // Initialize state from chapter when modal opens
  useEffect(() => {
    if (opened && chapter) {
      setChapterSettingsName(chapter.name);
      setChapterSettingsEaEnabled(chapter.earlyAccessConfig != null);
      setChapterSettingsEaBuzzPrice(chapter.earlyAccessConfig?.buzzPrice ?? MIN_BUZZ_PRICE);
      setChapterSettingsEaTimeframe(
        chapter.earlyAccessConfig?.timeframe ?? EARLY_ACCESS_CONFIG.timeframeValues[0]
      );
    }
  }, [opened, chapter]);

  if (!chapter) return null;

  const isPublished = chapter.status === ComicChapterStatus.Published;
  const currentEaConfig = chapter.earlyAccessConfig;

  // Allowed timeframe values: at most `maxDays`, AND at most the current
  // timeframe if EA was already configured (server forbids increasing).
  const ceilingDays = currentEaConfig
    ? Math.min(currentEaConfig.timeframe, maxDays)
    : maxDays;
  const baseAllowed = EARLY_ACCESS_CONFIG.timeframeValues.filter((d) => d <= ceilingDays);
  // Defensive: a grandfathered chapter may have a non-canonical timeframe
  // (e.g. `1` from before we constrained to the discrete set). Surface it
  // in the Select so the user isn't locked out of editing — picking any
  // canonical option below it is still a valid reduce.
  const allowedTimeframes =
    currentEaConfig &&
    !EARLY_ACCESS_CONFIG.timeframeValues.includes(currentEaConfig.timeframe)
      ? Array.from(new Set([...baseAllowed, currentEaConfig.timeframe])).sort((a, b) => a - b)
      : baseAllowed;
  const isEaUnavailable = !currentEaConfig && allowedTimeframes.length === 0;

  // Grandfathered chapters with a price below the current floor can only
  // reduce — clamp the floor to the existing price so the NumberInput
  // doesn't snap UP and trigger the server's "can't increase" check.
  const buzzPriceFloor = currentEaConfig
    ? Math.min(MIN_BUZZ_PRICE, currentEaConfig.buzzPrice)
    : MIN_BUZZ_PRICE;
  const buzzPriceCeiling = currentEaConfig
    ? Math.min(currentEaConfig.buzzPrice, 10000)
    : 10000;

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
              disabled={isEaUnavailable}
            />

            {isEaUnavailable && (
              <Alert color="yellow" variant="light" icon={<IconLock size={16} />}>
                <Text size="xs">
                  Early access unlocks as your creator score grows. Once you reach the first
                  tier, you&apos;ll be able to put chapters behind a paywall.
                </Text>
              </Alert>
            )}

            {chapterSettingsEaEnabled && (
              <>
                <NumberInput
                  label="Buzz Price"
                  description={
                    currentEaConfig
                      ? `Current: ${currentEaConfig.buzzPrice} Buzz (can only reduce)`
                      : `Amount of Buzz readers must pay (min ${MIN_BUZZ_PRICE}, max 10,000)`
                  }
                  value={chapterSettingsEaBuzzPrice}
                  onChange={(val) => setChapterSettingsEaBuzzPrice(val)}
                  min={buzzPriceFloor}
                  max={buzzPriceCeiling}
                  step={10}
                  clampBehavior="strict"
                  leftSection={<IconLock size={16} />}
                />
                <Select
                  label="Early Access Period"
                  description={
                    currentEaConfig
                      ? `Current: ${currentEaConfig.timeframe} days (can only reduce)`
                      : allowedTimeframes.length < EARLY_ACCESS_CONFIG.timeframeValues.length
                      ? `Up to ${maxDays} days at your current score. Higher tiers unlock longer windows.`
                      : 'After this period the chapter becomes free for everyone.'
                  }
                  data={allowedTimeframes.map((d) => ({
                    value: String(d),
                    label: `${d} day${d === 1 ? '' : 's'}`,
                  }))}
                  value={String(chapterSettingsEaTimeframe)}
                  onChange={(v) => v && setChapterSettingsEaTimeframe(Number(v))}
                  allowDeselect={false}
                  disabled={allowedTimeframes.length === 0}
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
