import {
  Badge,
  Button,
  Chip,
  Divider,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Title,
  TextInput,
} from '@mantine/core';
import { IconBolt, IconCheck, IconPhoto, IconTrash } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { ModelType } from '~/shared/utils/prisma/enums';
import { baseModels as ALL_BASE_MODELS } from '~/shared/constants/base-model.constants';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';

/**
 * Per-app settings panel. Renders two scope toggles (publisher_all_my_models
 * and viewer_personal), filter-chip multi-selects for model type / base
 * model, and the shared block settings (buzz_budget_per_gen + default
 * checkpoint version) that apply to both subscriptions.
 *
 * Each toggle independently calls upsertSubscription / deleteSubscription
 * so the user can persist one scope without committing the other. The
 * "Save block settings" button applies the shared settings to whichever
 * scopes are currently enabled.
 */
export interface AppSettingsModalProps {
  block: AvailableBlock;
  /**
   * The user's existing subscriptions for this app block, indexed by scope.
   * Both can be present, one, or neither. Caller is responsible for
   * filtering listMySubscriptions for this appBlockId.
   */
  existingByScope: Partial<Record<SubscriptionScope, SubscriptionRecord>>;
  onClose: () => void;
}

const MODEL_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: ModelType.Checkpoint, label: 'Checkpoint' },
  { value: ModelType.LORA, label: 'LoRA' },
  { value: ModelType.LoCon, label: 'LoCon' },
  { value: ModelType.TextualInversion, label: 'Embedding' },
  { value: ModelType.DoRA, label: 'DoRA' },
];

// Trim the full base-models list to the most commonly used set. The full
// list is ~80 entries — way too much UI for chips. Power users can extend
// in a follow-up; v1 covers the common case.
const BASE_MODEL_OPTIONS: string[] = (
  [
    'Flux.1 D',
    'Flux.1 S',
    'Flux.1 Kontext',
    'SDXL 1.0',
    'SD 1.5',
    'SD 3.5',
    'Pony',
    'Illustrious',
    'NoobAI',
    'Hunyuan 1',
    'WanVideo',
  ] as const
).filter((bm) => (ALL_BASE_MODELS as readonly string[]).includes(bm));

export function AppSettingsModal(props: AppSettingsModalProps) {
  const { block, existingByScope, onClose } = props;
  const utils = trpc.useUtils();
  const manifest = block.manifest as { name?: string; description?: string };

  // Initialise the form from existing subscriptions when present. Settings
  // are read from whichever scope has them set — they're meant to be
  // shared across both scopes so we use publisher's if both, viewer's
  // otherwise.
  const initialPub = existingByScope.publisher_all_my_models;
  const initialView = existingByScope.viewer_personal;
  const initialSettings = (initialPub?.settings ?? initialView?.settings ?? {}) as {
    buzz_budget_per_gen?: number;
    default_checkpoint_version_id?: number;
  };

  const [pubEnabled, setPubEnabled] = useState(!!initialPub);
  const [viewEnabled, setViewEnabled] = useState(!!initialView);
  const [pubModelTypes, setPubModelTypes] = useState<string[]>(initialPub?.targetModelTypes ?? []);
  const [pubBaseModels, setPubBaseModels] = useState<string[]>(initialPub?.targetBaseModels ?? []);
  const [viewModelTypes, setViewModelTypes] = useState<string[]>(
    initialView?.targetModelTypes ?? []
  );
  const [viewBaseModels, setViewBaseModels] = useState<string[]>(
    initialView?.targetBaseModels ?? []
  );
  const [buzzBudget, setBuzzBudget] = useState<number | ''>(
    typeof initialSettings.buzz_budget_per_gen === 'number'
      ? initialSettings.buzz_budget_per_gen
      : 50
  );
  const [checkpointId, setCheckpointId] = useState<number | null>(
    initialSettings.default_checkpoint_version_id ?? null
  );
  const [checkpointLabel, setCheckpointLabel] = useState<string>(
    initialSettings.default_checkpoint_version_id ? '(checkpoint set)' : 'Auto'
  );

  const sharedSettings = useMemo<Record<string, unknown>>(
    () => ({
      ...(typeof buzzBudget === 'number' ? { buzz_budget_per_gen: buzzBudget } : {}),
      ...(checkpointId ? { default_checkpoint_version_id: checkpointId } : {}),
    }),
    [buzzBudget, checkpointId]
  );

  const upsertMutation = trpc.blocks.upsertSubscription.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not save subscription',
        error: new Error(error.message),
      });
    },
  });
  const deleteMutation = trpc.blocks.deleteSubscription.useMutation({
    onSuccess: async () => {
      await utils.blocks.listMySubscriptions.invalidate();
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not remove subscription',
        error: new Error(error.message),
      });
    },
  });

  async function persistScope(scope: SubscriptionScope) {
    const enabled = scope === 'publisher_all_my_models' ? pubEnabled : viewEnabled;
    const modelTypes = scope === 'publisher_all_my_models' ? pubModelTypes : viewModelTypes;
    const baseModelsSel = scope === 'publisher_all_my_models' ? pubBaseModels : viewBaseModels;
    const existing = existingByScope[scope];
    if (!enabled) {
      if (existing) {
        await deleteMutation.mutateAsync({ subscriptionId: existing.id });
      }
      return;
    }
    await upsertMutation.mutateAsync({
      appBlockId: block.id,
      scope,
      targetModelTypes: modelTypes.length ? modelTypes : null,
      targetBaseModels: baseModelsSel.length ? baseModelsSel : null,
      settings: sharedSettings,
      enabled: true,
    });
  }

  async function handleSave() {
    try {
      await persistScope('publisher_all_my_models');
      await persistScope('viewer_personal');
      showSuccessNotification({
        title: 'Saved',
        message: `Your settings for "${manifest.name ?? block.blockId}" are up to date.`,
      });
      onClose();
    } catch {
      // Notifications already shown by the mutation error handlers.
    }
  }

  const handlePickCheckpoint = () => {
    openResourceSelectModal({
      title: 'Pick default checkpoint',
      onSelect: (resource) => {
        // The picker calls back with a GenerationResource — we keep the
        // model-version id and a small display label.
        setCheckpointId(resource.id);
        setCheckpointLabel(`${resource.model.name} — ${resource.name}`);
      },
      options: { resources: [{ type: ModelType.Checkpoint }] },
      selectSource: 'modelVersion',
    });
  };

  return (
    <Modal
      opened
      onClose={onClose}
      title={<Title order={4}>{manifest.name ?? block.blockId}</Title>}
      size="lg"
      scrollAreaComponent={ScrollArea.Autosize}
    >
      <Stack gap="md">
        {manifest.description && (
          <Text size="sm" c="dimmed">
            {manifest.description}
          </Text>
        )}

        <Divider label="Where to show this" labelPosition="left" />

        <Stack gap="xs">
          <Switch
            checked={pubEnabled}
            onChange={(e) => setPubEnabled(e.currentTarget.checked)}
            label="Show to everyone on my models"
            description="Adds this block to every model you own (unless you opt out per-model)."
          />
          {pubEnabled && (
            <Stack gap={6} ml="md">
              <Text size="xs" fw={500}>
                Limit to model types (leave empty for all)
              </Text>
              <Chip.Group
                multiple
                value={pubModelTypes}
                onChange={(v) => setPubModelTypes(v as string[])}
              >
                <Group gap={6}>
                  {MODEL_TYPE_OPTIONS.map((opt) => (
                    <Chip key={opt.value} value={opt.value} size="xs">
                      {opt.label}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
              <Text size="xs" fw={500}>
                Limit to base models (leave empty for all)
              </Text>
              <Chip.Group
                multiple
                value={pubBaseModels}
                onChange={(v) => setPubBaseModels(v as string[])}
              >
                <Group gap={6}>
                  {BASE_MODEL_OPTIONS.map((bm) => (
                    <Chip key={bm} value={bm} size="xs">
                      {bm}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
            </Stack>
          )}
        </Stack>

        <Stack gap="xs">
          <Switch
            checked={viewEnabled}
            onChange={(e) => setViewEnabled(e.currentTarget.checked)}
            label="Show to me on all models"
            description="Adds this block to every model page you visit."
          />
          {viewEnabled && (
            <Stack gap={6} ml="md">
              <Text size="xs" fw={500}>
                Limit to model types (leave empty for all)
              </Text>
              <Chip.Group
                multiple
                value={viewModelTypes}
                onChange={(v) => setViewModelTypes(v as string[])}
              >
                <Group gap={6}>
                  {MODEL_TYPE_OPTIONS.map((opt) => (
                    <Chip key={opt.value} value={opt.value} size="xs">
                      {opt.label}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
              <Text size="xs" fw={500}>
                Limit to base models (leave empty for all)
              </Text>
              <Chip.Group
                multiple
                value={viewBaseModels}
                onChange={(v) => setViewBaseModels(v as string[])}
              >
                <Group gap={6}>
                  {BASE_MODEL_OPTIONS.map((bm) => (
                    <Chip key={bm} value={bm} size="xs">
                      {bm}
                    </Chip>
                  ))}
                </Group>
              </Chip.Group>
            </Stack>
          )}
        </Stack>

        <Divider label="Block settings" labelPosition="left" />

        <NumberInput
          label="Buzz budget per generation"
          description="Yellow buzz cap per generation this block can submit."
          leftSection={<IconBolt size={16} />}
          min={1}
          max={1000}
          value={buzzBudget}
          onChange={(v) => setBuzzBudget(typeof v === 'number' ? v : '')}
        />

        <Group align="end" gap="sm">
          <TextInput
            label="Default checkpoint"
            description="Auto-pick by ecosystem if unset."
            value={checkpointLabel}
            readOnly
            leftSection={<IconPhoto size={16} />}
            style={{ flex: 1 }}
          />
          <Button variant="default" onClick={handlePickCheckpoint}>
            Change
          </Button>
          {checkpointId && (
            <Button
              variant="subtle"
              color="red"
              leftSection={<IconTrash size={14} />}
              onClick={() => {
                setCheckpointId(null);
                setCheckpointLabel('Auto');
              }}
            >
              Clear
            </Button>
          )}
        </Group>

        <Group justify="space-between" mt="md">
          <Badge variant="light">
            {[pubEnabled && 'On my models', viewEnabled && 'On pages I view']
              .filter(Boolean)
              .join(' + ') || 'No scopes selected'}
          </Badge>
          <Group>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              leftSection={<IconCheck size={16} />}
              loading={upsertMutation.isLoading || deleteMutation.isLoading}
              onClick={handleSave}
            >
              Save
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * Convenience opener — drops the modal into the dialog store with the
 * given props and wires up the onClose to closeById.
 */
export function openAppSettingsModal(props: Omit<AppSettingsModalProps, 'onClose'>) {
  const id = `app-settings-${props.block.id}`;
  dialogStore.trigger({
    id,
    component: AppSettingsModal,
    props: {
      ...props,
      onClose: () => dialogStore.closeById(id),
    },
  });
}
