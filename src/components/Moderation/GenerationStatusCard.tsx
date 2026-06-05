import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { showNotification } from '@mantine/notifications';
import { IconPhoto, IconServer } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type {
  GenerationStatusMode,
  GenerationStatusUpdatedBy,
} from '~/server/schema/generation.schema';
import { trpc } from '~/utils/trpc';
import { generationStatusDefaultMessage } from '~/server/schema/generation.schema';

const MODE_OPTIONS: { label: string; value: GenerationStatusMode }[] = [
  { label: 'Enabled', value: 'enabled' },
  { label: 'Members only', value: 'memberOnly' },
  { label: 'Disabled', value: 'disabled' },
];

const MODE_BADGE: Record<GenerationStatusMode, { label: string; color: string }> = {
  enabled: { label: 'Available', color: 'green' },
  memberOnly: { label: 'Members only', color: 'yellow' },
  disabled: { label: 'Unavailable', color: 'red' },
};

const GLOBAL_MODE_DESCRIPTION: Record<GenerationStatusMode, string> = {
  enabled: 'All users can generate.',
  memberOnly: 'Only members can generate. Free (non-member) users are blocked.',
  disabled: 'No users can generate.',
};

const SELF_HOSTED_MODE_DESCRIPTION: Record<GenerationStatusMode, string> = {
  enabled: 'All users can use Civitai-hosted models.',
  memberOnly:
    'Only members can use Civitai-hosted models. Free users see them disabled in the picker.',
  disabled: 'No users can use Civitai-hosted models. They are disabled in the picker for everyone.',
};

function RestrictedByBadge({ updatedBy }: { updatedBy?: GenerationStatusUpdatedBy | null }) {
  if (!updatedBy) return null;
  const when = new Date(updatedBy.at);
  return (
    <Text size="xs" c="dimmed">
      Restricted by {updatedBy.username}
      {!isNaN(when.getTime()) ? ` · ${when.toLocaleString()}` : ''}
    </Text>
  );
}

type StatusCardBaseProps = {
  title: string;
  icon: ReactNode;
  /** Per-mode helper text shown under the segmented control. */
  modeDescription: Record<GenerationStatusMode, string>;
  isLoading: boolean;
  currentMode?: GenerationStatusMode;
  currentMessage?: string | null;
  currentUpdatedBy?: GenerationStatusUpdatedBy | null;
  isSaving: boolean;
  /** Whether this toggle has an editable status message (false → mode only). */
  showMessage?: boolean;
  // Returns a promise that settles when the save round-trip is done. We hold
  // `dirty` until it resolves so the effect below doesn't snap the local mode
  // back to the stale query value before the optimistic/refetched value lands.
  onSave: (input: {
    mode: GenerationStatusMode;
    message?: string | null;
  }) => void | Promise<unknown>;
};

function StatusCardBase({
  title,
  icon,
  modeDescription,
  isLoading,
  currentMode,
  currentMessage,
  currentUpdatedBy,
  isSaving,
  showMessage = true,
  onSave,
}: StatusCardBaseProps) {
  const [mode, setMode] = useState<GenerationStatusMode>('enabled');
  const [message, setMessage] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!currentMode || dirty) return;
    setMode(currentMode in MODE_BADGE ? currentMode : 'enabled');
    setMessage(currentMessage ?? '');
  }, [currentMode, currentMessage, dirty]);

  const handleSave = async () => {
    // Only send `message` when it actually changed, so a mode-only save keeps
    // the stored message. Omitting it (undefined) tells the server to preserve.
    const messageEdited = showMessage && message !== (currentMessage ?? '');
    try {
      await onSave({
        mode,
        ...(messageEdited ? { message: message.trim() ? message : null } : {}),
      });
      setDirty(false);
    } catch {
      // Keep `dirty` so the user can retry; the mutation surfaces the error.
    }
  };

  const restricted = mode !== 'enabled';

  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group gap="sm" align="center" justify="space-between">
          <Group gap="sm" align="center">
            {icon}
            <Title order={4}>{title}</Title>
          </Group>
          {!isLoading &&
            currentMode &&
            (() => {
              const badge = MODE_BADGE[currentMode] ?? MODE_BADGE.enabled;
              return (
                <Badge color={badge.color} variant="light">
                  {badge.label}
                </Badge>
              );
            })()}
        </Group>

        {isLoading ? (
          <Group justify="center" py="md">
            <Loader size="sm" />
          </Group>
        ) : (
          <>
            <Stack gap={4}>
              <SegmentedControl
                value={mode}
                onChange={(value) => {
                  setMode(value as GenerationStatusMode);
                  setDirty(true);
                }}
                data={MODE_OPTIONS}
              />
              <Text size="xs" c="dimmed">
                {modeDescription[mode]}
              </Text>
              {currentMode && currentMode !== 'enabled' && (
                <RestrictedByBadge updatedBy={currentUpdatedBy} />
              )}
            </Stack>
            {showMessage && (
              <>
                <Textarea
                  label="Status message"
                  description="Shown to blocked users when generation is restricted. Leave blank for a default message."
                  placeholder={`e.g. ${generationStatusDefaultMessage}`}
                  value={message}
                  onChange={(e) => {
                    setMessage(e.currentTarget.value);
                    setDirty(true);
                  }}
                  minRows={2}
                  maxRows={6}
                  autosize
                  maxLength={2000}
                />
                {restricted && !message.trim() && (
                  <Alert color="yellow" variant="light">
                    Generation is restricted but no message is set. Consider adding a message so
                    users know what is happening.
                  </Alert>
                )}
              </>
            )}
            <Group justify="flex-end">
              <Button onClick={handleSave} loading={isSaving} disabled={!dirty}>
                Save
              </Button>
            </Group>
          </>
        )}
      </Stack>
    </Card>
  );
}

export function GenerationStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getStatusModerator.useQuery();
  const setStatus = trpc.generation.setStatus.useMutation({
    // Optimistically reflect the new mode/message in the card immediately.
    onMutate: async (input) => {
      await utils.generation.getStatusModerator.cancel();
      const prev = utils.generation.getStatusModerator.getData();
      utils.generation.getStatusModerator.setData(undefined, (old) =>
        old
          ? {
              ...old,
              mode: input.mode,
              message: input.message === undefined ? old.message : input.message,
            }
          : old
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) utils.generation.getStatusModerator.setData(undefined, ctx.prev);
      showNotification({ title: 'Error', message: error.message, color: 'red' });
    },
    onSuccess: () => {
      showNotification({
        title: 'Saved',
        message: 'Image generation status updated',
        color: 'green',
      });
    },
    onSettled: () => utils.generation.getStatusModerator.invalidate(),
  });

  return (
    <StatusCardBase
      title="Image Generation"
      icon={<IconPhoto size={20} />}
      modeDescription={GLOBAL_MODE_DESCRIPTION}
      isLoading={isLoading}
      currentMode={data?.mode}
      currentMessage={data?.message}
      currentUpdatedBy={data?.updatedBy}
      isSaving={setStatus.isPending}
      onSave={(input) => setStatus.mutateAsync(input)}
    />
  );
}

export function SelfHostedGenerationStatusCard() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getStatusModerator.useQuery();
  const setStatus = trpc.generation.setSelfHostedStatus.useMutation({
    // Optimistically reflect the new self-hosted mode in the card.
    onMutate: async (input) => {
      await utils.generation.getStatusModerator.cancel();
      const prev = utils.generation.getStatusModerator.getData();
      utils.generation.getStatusModerator.setData(undefined, (old) =>
        old ? { ...old, selfHostedMode: input.mode } : old
      );
      return { prev };
    },
    onError: (error, _vars, ctx) => {
      if (ctx?.prev) utils.generation.getStatusModerator.setData(undefined, ctx.prev);
      showNotification({ title: 'Error', message: error.message, color: 'red' });
    },
    onSuccess: () => {
      showNotification({
        title: 'Saved',
        message: 'Self-hosted generation status updated',
        color: 'green',
      });
    },
    onSettled: () =>
      Promise.all([
        utils.generation.getStatusModerator.invalidate(),
        // The toggle changes `selfHostedMode` + the resolved disabled list that
        // the generator reads via `getGenerationConfig` (cached staleTime:
        // Infinity), so it must be invalidated for the picker/alert to update.
        utils.generation.getGenerationConfig.invalidate(),
      ]),
  });

  return (
    <StatusCardBase
      title="Self-Hosted Generation"
      icon={<IconServer size={20} />}
      modeDescription={SELF_HOSTED_MODE_DESCRIPTION}
      isLoading={isLoading}
      currentMode={data?.selfHostedMode}
      currentUpdatedBy={data?.selfHostedUpdatedBy}
      isSaving={setStatus.isPending}
      showMessage={false}
      onSave={({ mode }) => setStatus.mutateAsync({ mode })}
    />
  );
}
