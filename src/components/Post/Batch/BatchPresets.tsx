import { Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useState } from 'react';
import { DEFAULT_STRENGTH_RANGE } from '~/shared/constants/generation.constants';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { usePostPresets } from '~/components/Post/post-presets.utils';
import { MAX_MANUAL_RESOURCES_PER_IMAGE } from '~/server/common/constants';
import type { PostPresetData } from '~/server/schema/post-preset.schema';
import { POST_PRESET_NAME_LIMIT } from '~/server/schema/post-preset.schema';
import type { PostPreset } from '~/server/services/post-preset.service';
import type { GenerationResource } from '~/shared/types/generation.types';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { SharedSettings } from './batch-composer.store';
import { useBatchComposerStore } from './batch-composer.store';

export function toPresetData(shared: SharedSettings): PostPresetData {
  return {
    resources: shared.resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      baseModel: resource.baseModel,
      model: { id: resource.model.id, name: resource.model.name, type: resource.model.type },
    })),
    tools: shared.tools.map(({ id, name }) => ({ id, name })),
    techniques: shared.techniques.map(({ id, name }) => ({ id, name })),
    tags: shared.tags,
    titleTemplate: shared.titleTemplate,
  };
}

export function fromPresetData(
  data: PostPresetData,
  promotedVersionId: number | null
): Omit<SharedSettings, 'promotedVersionId'> {
  const resources: GenerationResource[] = data.resources
    .filter((resource) => resource.id !== promotedVersionId)
    .slice(0, MAX_MANUAL_RESOURCES_PER_IMAGE - (promotedVersionId ? 1 : 0))
    .map((resource) => ({
      ...resource,
      trainedWords: [],
      canGenerate: false,
      hasAccess: true,
      settings: { strength: DEFAULT_STRENGTH_RANGE },
      strength: 1,
    }));
  return {
    resources,
    tools: data.tools,
    techniques: data.techniques,
    tags: data.tags,
    titleTemplate: data.titleTemplate,
  };
}

export function PresetSelect({ disabled }: { disabled?: boolean }) {
  const [presetId, promotedVersionId, applyPreset] = useBatchComposerStore((state) => [
    state.presetId,
    state.shared.promotedVersionId,
    state.applyPreset,
  ]);
  const { data: presets, isError, isLoading } = usePostPresets();
  const unavailable = isError || !presets?.length;

  return (
    <Select
      label="Preset"
      size="sm"
      className="max-w-[320px]"
      classNames={{ root: 'flex items-center gap-3', label: 'shrink-0 sm:w-24', wrapper: 'flex-1' }}
      placeholder={
        isLoading
          ? 'Loading…'
          : isError
          ? 'Presets unavailable'
          : !presets?.length
          ? 'No saved presets'
          : 'none'
      }
      data={(presets ?? []).map((preset) => ({ value: String(preset.id), label: preset.name }))}
      value={presetId ? String(presetId) : null}
      onChange={(value) => {
        const preset = presets?.find((x) => String(x.id) === value);
        if (!preset) return applyPreset(null, {});
        applyPreset(preset.id, fromPresetData(preset.data, promotedVersionId));
      }}
      disabled={disabled || unavailable}
      clearable
      data-testid="batch-preset-select"
    />
  );
}

export function SavePresetButton({ disabled }: { disabled?: boolean }) {
  const [shared, presetId, applyPreset] = useBatchComposerStore((state) => [
    state.shared,
    state.presetId,
    state.applyPreset,
  ]);
  const { data: presets, isError } = usePostPresets();

  return (
    <Button
      size="compact-xs"
      variant="subtle"
      color="gray"
      leftSection={<IconDeviceFloppy size={14} />}
      disabled={disabled || isError}
      onClick={() =>
        dialogStore.trigger({
          component: SavePresetModal,
          props: {
            data: toPresetData(shared),
            presets: presets ?? [],
            initialId: presetId,
            onSaved: (saved) =>
              applyPreset(saved.id, fromPresetData(saved.data, shared.promotedVersionId)),
          },
        })
      }
    >
      Save as preset…
    </Button>
  );
}

const NEW_PRESET = 'new';

function SavePresetModal({
  data,
  presets,
  initialId,
  onSaved,
}: {
  data: PostPresetData;
  presets: PostPreset[];
  initialId: number | null;
  onSaved: (preset: PostPreset) => void;
}) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const initial = presets.find((preset) => preset.id === initialId) ?? null;
  const [target, setTarget] = useState<string>(initial ? String(initial.id) : NEW_PRESET);
  const [name, setName] = useState(initial?.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const overwriting = presets.find((preset) => String(preset.id) === target) ?? null;

  const upsert = trpc.postPreset.upsert.useMutation({
    onSuccess: async (saved) => {
      await utils.postPreset.getAll.invalidate();
      showSuccessNotification({ message: `Saved preset "${saved.name}"` });
      onSaved(saved);
      dialog.onClose();
    },
    onError: (error) => setError(error.message),
  });
  const remove = trpc.postPreset.delete.useMutation({
    onSuccess: async () => {
      await utils.postPreset.getAll.invalidate();
      dialog.onClose();
    },
    onError: (error) => showErrorNotification({ title: 'Could not delete preset', error }),
  });

  const trimmed = name.trim();
  const busy = upsert.isPending || remove.isPending;

  return (
    <Modal {...dialog} title="Save as preset" size="sm">
      <Stack gap="sm">
        <Select
          label="Save to"
          data={[
            { value: NEW_PRESET, label: 'New preset' },
            ...presets.map((preset) => ({ value: String(preset.id), label: preset.name })),
          ]}
          value={target}
          onChange={(value) => {
            const next = value ?? NEW_PRESET;
            setTarget(next);
            setError(null);
            const preset = presets.find((x) => String(x.id) === next);
            if (preset) setName(preset.name);
          }}
          allowDeselect={false}
        />
        <TextInput
          label="Name"
          value={name}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
          maxLength={POST_PRESET_NAME_LIMIT}
          error={error}
          autoFocus
          data-autofocus
        />
        <Text size="xs" c="dimmed">
          Saves the resources, tools, techniques, tags and title template of this section.
        </Text>
        <Group justify="space-between">
          {overwriting ? (
            <Button
              variant="subtle"
              color="red"
              size="compact-sm"
              loading={remove.isPending}
              disabled={busy}
              onClick={() => remove.mutate({ id: overwriting.id })}
            >
              Delete preset
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={dialog.onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              loading={upsert.isPending}
              disabled={!trimmed || busy}
              onClick={() => upsert.mutate({ id: overwriting?.id, name: trimmed, data })}
            >
              {overwriting ? 'Overwrite' : 'Save'}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
