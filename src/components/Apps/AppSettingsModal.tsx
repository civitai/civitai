import {
  Badge,
  Button,
  Chip,
  Divider,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ModelType } from '~/shared/utils/prisma/enums';
import { baseModels as ALL_BASE_MODELS } from '~/shared/constants/base-model.constants';
import type {
  AvailableBlock,
  SubscriptionRecord,
  SubscriptionScope,
} from '~/server/schema/blocks/subscription.schema';
import type {
  ManifestSettings,
  ManifestSettingField,
} from '~/server/schema/blocks/manifest-settings.meta.schema';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';

/**
 * Per-app settings panel. Renders the two subscription-target toggles
 * (publisher_all_my_models, viewer_personal) plus a manifest-driven
 * settings form. Each toggle independently calls upsertSubscription /
 * deleteSubscription so the user can persist one target without
 * committing the other. The outer Save button applies the collected
 * settings to whichever targets are currently enabled.
 *
 * Settings UI is driven entirely by `block.manifest.settings` — no
 * hardcoded fields. Apps that don't declare a `settings` schema render
 * no form (and the block-settings divider is hidden). The contract
 * mirrors `@civitai/app-sdk/blocks` `ManifestSettings`; the W3 server
 * validator (`validateBlockSettings`) is the authoritative gate.
 *
 * v0 quirk: this modal renders only `scope: 'publisher'` fields today
 * (collected settings are applied to both subscriptions when both
 * toggles are on, matching the pre-Phase-4 semantics). When a real
 * `scope: 'viewer'` use case lands, this should grow per-toggle panels.
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
  const manifest = block.manifest as {
    name?: string;
    description?: string;
    settings?: ManifestSettings;
    scopes?: string[];
  };

  // `block.manifest` may be the PUBLIC marketplace allowlist (F-E E1) —
  // name/description/targets only, with `settings`/`scopes` deliberately
  // stripped so anon callers never see manifest internals. When this modal is
  // opened from a marketplace card (install path), reading the settings form
  // from `block.manifest.settings` would therefore render NO fields. Fetch the
  // install-needed bits (settings meta + declared scopes) from the
  // authenticated `getInstallConfig` procedure instead, keyed on appBlockId.
  // The "Manage" path (/apps/installed) passes the FULL manifest, so its
  // `manifest.settings` is already populated; the fetched value matches it.
  const { data: installConfig } = trpc.blocks.getInstallConfig.useQuery(
    { appBlockId: block.id },
    { staleTime: 60_000 }
  );

  // Manifest-driven settings (W3 Phase 4). Fields without an explicit
  // `scope:` declaration are treated as 'publisher' for back-compat with
  // pre-W3 manifests (the gate that produced them only required type +
  // label + description). New manifests should declare scope explicitly.
  //
  // Source precedence: the authenticated install config (always carries
  // settings/scopes, regardless of whether `block.manifest` was the public
  // subset) wins; fall back to `block.manifest.settings` while it loads (the
  // Manage path already has the full manifest, so the form is correct
  // immediately there).
  const settingsSource = installConfig?.settings ?? manifest.settings;
  const manifestSettings = useMemo<ManifestSettings>(
    () => normalizeManifestSettings(settingsSource),
    [settingsSource]
  );
  const declaredScopes = installConfig?.scopes ?? manifest.scopes ?? [];

  // Initialise the form from existing subscriptions when present. Settings
  // are read from whichever scope has them set — they're meant to be
  // shared across both scopes so we use publisher's if both, viewer's
  // otherwise.
  const initialPub = existingByScope.publisher_all_my_models;
  const initialView = existingByScope.viewer_personal;
  const initialSettings = (initialPub?.settings ?? initialView?.settings ?? {}) as Record<
    string,
    unknown
  >;

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

  // Seed each visible manifest field from existing-subscription settings or
  // the field's declared default. Keys not declared in the manifest are
  // dropped — old install rows that carried legacy magic fields (e.g.
  // `default_checkpoint_version_id` set by the pre-Phase-4 hardcoded UI)
  // are preserved on the row by the server (we only overwrite the keys we
  // submit), so this isn't destructive.
  const [settingsValues, setSettingsValues] = useState<Record<string, unknown>>(() =>
    seedSettingsValues(manifestSettings, initialSettings)
  );

  // Re-seed when the manifest settings schema becomes available. On the install
  // path `manifestSettings` is empty on first render (getInstallConfig hasn't
  // resolved yet) so the initial seed has no field defaults; once the schema
  // arrives we merge in any declared defaults for keys the user hasn't touched.
  // Existing-subscription values (initialSettings) and user edits always win,
  // so this never clobbers what the user already has/typed.
  const seededKeysRef = useRef<string>('');
  useEffect(() => {
    const keysSig = Object.keys(manifestSettings).sort().join(',');
    if (keysSig === seededKeysRef.current) return;
    seededKeysRef.current = keysSig;
    setSettingsValues((prev) => {
      const reseeded = seedSettingsValues(manifestSettings, initialSettings);
      // Preserve any value the user already set / that was already present.
      return { ...reseeded, ...prev };
    });
    // initialSettings is derived from props (existing subscriptions) and is
    // stable for the modal's lifetime; depend only on the schema shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestSettings]);

  const handleSettingChange = (key: string, value: unknown) => {
    setSettingsValues((prev) => ({ ...prev, [key]: value }));
  };

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
    // Preserve unknown keys on the existing row (e.g. legacy
    // `default_checkpoint_version_id` injected by the pre-Phase-4
    // hardcoded UI — still read by the platform's checkpoint resolution
    // chain). Manifest-declared keys are overwritten with the form's
    // current values.
    const existingSettings = (existing?.settings ?? {}) as Record<string, unknown>;
    const passthroughKeys = Object.keys(existingSettings).filter(
      (k) => !Object.prototype.hasOwnProperty.call(manifestSettings, k)
    );
    const mergedSettings: Record<string, unknown> = { ...settingsValues };
    for (const k of passthroughKeys) mergedSettings[k] = existingSettings[k];

    await upsertMutation.mutateAsync({
      appBlockId: block.id,
      scope,
      targetModelTypes: modelTypes.length ? modelTypes : null,
      targetBaseModels: baseModelsSel.length ? baseModelsSel : null,
      settings: mergedSettings,
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

  // Visible publisher-slice fields drive whether we render the
  // "Block settings" section at all. Apps that don't declare any
  // publisher settings (e.g. who-am-i, hello-world) skip the divider.
  const visiblePublisherFields = useMemo(
    () =>
      Object.entries(manifestSettings).filter(([, def]) =>
        isFieldVisible(def, 'publisher', declaredScopes)
      ),
    [manifestSettings, declaredScopes]
  );
  const hasBlockSettings = visiblePublisherFields.length > 0;

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

        {hasBlockSettings && (
          <>
            <Divider label="Block settings" labelPosition="left" />
            <Stack gap="xs">
              {visiblePublisherFields.map(([key, def]) => (
                <ManifestField
                  key={key}
                  fieldKey={key}
                  def={def}
                  value={settingsValues[key]}
                  onChange={(v) => handleSettingChange(key, v)}
                />
              ))}
            </Stack>
          </>
        )}

        <Group justify="space-between" mt="md">
          <Badge variant="light">
            {[pubEnabled && 'On my models', viewEnabled && 'On pages I view']
              .filter(Boolean)
              .join(' + ') || 'No targets selected'}
          </Badge>
          <Group>
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              leftSection={<IconCheck size={16} />}
              loading={upsertMutation.isPending || deleteMutation.isPending}
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

// ---------------------------------------------------------------------------
// Manifest-driven settings helpers (W3 Phase 4)
// ---------------------------------------------------------------------------

type ManifestScope = 'publisher' | 'viewer';

/**
 * Coerce missing optional fields on each setting def into the values the
 * runtime validator (and this renderer) want to see. Pre-W3 manifests
 * may omit `scope` (treat as 'publisher') and `widget` (treat as the
 * default for the type).
 */
function normalizeManifestSettings(input: unknown): ManifestSettings {
  if (!input || typeof input !== 'object') return {};
  const out: ManifestSettings = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const def = raw as Record<string, unknown>;
    const type = def.type;
    if (type !== 'number' && type !== 'string' && type !== 'boolean') continue;
    const scope =
      def.scope === 'publisher' || def.scope === 'viewer' ? def.scope : 'publisher';
    const base = {
      ...def,
      scope,
    };
    // Cast via unknown is safe — the discriminated union narrows on `type`
    // and we've validated it above.
    out[key] = base as unknown as ManifestSettingField;
  }
  return out;
}

function isFieldVisible(
  field: ManifestSettingField,
  forScope: ManifestScope,
  declaredScopes: string[]
): boolean {
  if (field.scope !== forScope) return false;
  if (field.requires_scope && !declaredScopes.includes(field.requires_scope)) return false;
  return true;
}

function seedSettingsValues(
  manifestSettings: ManifestSettings,
  initial: Record<string, unknown>
): Record<string, unknown> {
  const seed: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(manifestSettings)) {
    if (Object.prototype.hasOwnProperty.call(initial, key)) {
      seed[key] = initial[key];
    } else if (def.default !== undefined && def.default !== null) {
      seed[key] = def.default;
    }
  }
  return seed;
}

/**
 * Renders a single manifest setting field as Mantine inputs. Mirrors the
 * widget contract from `manifest-settings.meta.schema.ts`:
 *   number/number   → NumberInput
 *   number/slider   → NumberInput (slider widget is a v1 polish item)
 *   number/resource_picker → TextInput + picker button (Checkpoint only today)
 *   string/text     → TextInput
 *   string/textarea → Textarea
 *   string/select   → Select
 *   boolean/toggle  → Switch
 */
function ManifestField(props: {
  fieldKey: string;
  def: ManifestSettingField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { def, value, onChange } = props;

  if (def.type === 'number') {
    const widget = def.widget ?? 'number';
    if (widget === 'resource_picker') {
      const opts = (def.widget_options ?? {}) as { resource_type?: string };
      const resourceType = (opts.resource_type as ModelType) ?? ModelType.Checkpoint;
      const display = typeof value === 'number' ? `(id: ${value})` : 'Auto';
      return (
        <Group align="end" gap="sm">
          <TextInput
            label={def.label}
            description={def.description}
            value={display}
            readOnly
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            onClick={() =>
              openResourceSelectModal({
                title: `Pick ${def.label}`,
                onSelect: (resource) => onChange(resource.id),
                options: { resources: [{ type: resourceType }] },
                selectSource: 'modelVersion',
              })
            }
          >
            Change
          </Button>
          {value != null && (
            <Button variant="subtle" color="red" onClick={() => onChange(null)}>
              Clear
            </Button>
          )}
        </Group>
      );
    }
    return (
      <NumberInput
        label={def.label}
        description={def.description}
        min={def.min}
        max={def.max}
        step={def.step}
        value={typeof value === 'number' ? value : ''}
        onChange={(v) => onChange(typeof v === 'number' ? v : null)}
      />
    );
  }

  if (def.type === 'string') {
    const widget = def.widget ?? 'text';
    const v = typeof value === 'string' ? value : '';
    if (widget === 'textarea') {
      return (
        <Textarea
          label={def.label}
          description={def.description}
          value={v}
          onChange={(e) => onChange(e.currentTarget.value)}
          maxLength={def.max_length}
          autosize
          minRows={2}
        />
      );
    }
    if (widget === 'select') {
      return (
        <Select
          label={def.label}
          description={def.description}
          data={def.enum ?? []}
          value={v || null}
          onChange={(picked) => onChange(picked ?? '')}
        />
      );
    }
    return (
      <TextInput
        label={def.label}
        description={def.description}
        value={v}
        onChange={(e) => onChange(e.currentTarget.value)}
        maxLength={def.max_length}
      />
    );
  }

  // boolean
  return (
    <Switch
      label={def.label}
      description={def.description}
      checked={typeof value === 'boolean' ? value : false}
      onChange={(e) => onChange(e.currentTarget.checked)}
    />
  );
}

// ---------------------------------------------------------------------------

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
