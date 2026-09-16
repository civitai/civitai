import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconInfoCircle, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type {
  GateAvailableTo,
  GatePresentation,
  GateRule,
} from '~/shared/data-graph/generation/gates';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  TargetDetails,
  TargetInputs,
  normalizeKeys,
  parseIds,
  type TargetValues,
} from './target-inputs';

const PRESENTATION_BADGE: Record<GatePresentation, { label: string; color: string }> = {
  hidden: { label: 'Hidden', color: 'red' },
  disabled: { label: 'Disabled', color: 'orange' },
  experimental: { label: 'Experimental', color: 'yellow' },
};

/**
 * `(presentation, availableTo)` are orthogonal in storage, but as two dropdowns
 * they read as half an inverted condition each — the mod has to compose "who
 * keeps access" with "how it looks to everyone else" to answer "why is Flux
 * gone". One list of whole outcomes says it outright.
 *
 * `experimental` is a single entry because it grants no access, so it has no
 * exempt tier to vary (see `applicableRulesFor`).
 */
const RULE_KIND_OPTIONS = [
  {
    group: 'Hidden — removed from the picker entirely',
    items: [
      { value: 'hidden:nobody', label: 'Hidden from everyone, moderators included' },
      { value: 'hidden:moderators', label: 'Hidden from everyone except moderators' },
      { value: 'hidden:testers', label: 'Hidden from everyone except testers + mods' },
      { value: 'hidden:members', label: 'Hidden from everyone except members + mods' },
    ],
  },
  {
    group: 'Disabled — still selectable, but generation is blocked',
    items: [
      { value: 'disabled:nobody', label: 'Disabled for everyone, moderators included' },
      { value: 'disabled:moderators', label: 'Disabled for everyone except moderators' },
      { value: 'disabled:testers', label: 'Disabled for everyone except testers + mods' },
      { value: 'disabled:members', label: 'Members only — greyed out with a Become-a-member CTA' },
    ],
  },
  {
    group: 'Experimental — not a gate',
    items: [{ value: 'experimental', label: 'Experimental warning — usable, nothing blocked' }],
  },
];

type RuleForm = TargetValues & {
  id: string;
  name: string;
  availableTo: GateAvailableTo;
  presentation: GatePresentation;
  message: string;
};

type RuleKindFields = Pick<RuleForm, 'presentation' | 'availableTo'>;

const ruleKindValue = (rule: RuleKindFields) =>
  rule.presentation === 'experimental'
    ? 'experimental'
    : `${rule.presentation}:${rule.availableTo}`;

const parseRuleKind = (value: string): RuleKindFields => {
  if (value === 'experimental') return { presentation: 'experimental', availableTo: 'nobody' };
  const [presentation, availableTo] = value.split(':');
  return {
    presentation: presentation as GatePresentation,
    availableTo: availableTo as GateAvailableTo,
  };
};

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rule-${Date.now()}`;

const toForm = (rule?: GateRule): RuleForm => ({
  id: rule?.id ?? newId(),
  name: rule?.name ?? '',
  availableTo: rule?.availableTo ?? 'members',
  presentation: rule?.presentation ?? 'disabled',
  message: rule?.message ?? '',
  ecosystems: rule?.ecosystems ?? [],
  workflows: rule?.workflows ?? [],
  modelVersionIds: rule?.modelVersionIds.map(String) ?? [],
});

function useInvalidateGateRules() {
  const queryUtils = trpc.useUtils();
  return () => {
    queryUtils.generation.getGateRules.invalidate();
    queryUtils.generation.getGenerationConfig.invalidate();
  };
}

function GateRuleModal({ rule }: { rule?: GateRule }) {
  const dialog = useDialogContext();
  const invalidate = useInvalidateGateRules();
  const [form, setForm] = useState<RuleForm>(() => toForm(rule));
  const update = (patch: Partial<RuleForm>) => setForm((f) => ({ ...f, ...patch }));
  // Inside a modal, dropdowns must portal or the modal body clips them.
  const comboboxProps = {
    withinPortal: true,
    zIndex: dialog.zIndex ? dialog.zIndex + 1 : undefined,
  };

  const saveMutation = trpc.generation.saveGateRule.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Gate rule saved. Changes propagate as caches refresh.',
      });
      invalidate();
      dialog.onClose();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Save failed', error: new Error(err.message) }),
  });

  const handleSave = () => {
    const { ids, invalid } = parseIds(form.modelVersionIds);
    if (invalid.length) {
      showErrorNotification({
        title: 'Invalid model version IDs',
        error: new Error(`Not positive integers: ${invalid.join(', ')}`),
      });
      return;
    }
    saveMutation.mutate({
      id: form.id,
      name: form.name.trim(),
      // Experimental has no exempt tier; pin it so an older stored
      // `availableTo` the UI no longer offers can't survive a save.
      availableTo: form.presentation === 'experimental' ? 'nobody' : form.availableTo,
      presentation: form.presentation,
      message: form.message.trim() || undefined,
      ecosystems: normalizeKeys(form.ecosystems),
      workflows: normalizeKeys(form.workflows),
      modelVersionIds: ids,
    });
  };

  return (
    <Modal
      {...dialog}
      title={<Text fw={600}>{rule ? 'Edit gate rule' : 'New gate rule'}</Text>}
      size="lg"
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="e.g. Maintenance window"
          value={form.name}
          onChange={(e) => update({ name: e.currentTarget.value })}
          data-autofocus
        />
        <Select
          label="Rule"
          data={RULE_KIND_OPTIONS}
          value={ruleKindValue(form)}
          onChange={(v) => v && update(parseRuleKind(v))}
          allowDeselect={false}
          comboboxProps={comboboxProps}
        />
        <Textarea
          label="Message (optional)"
          description="Extra copy layered on the standard badge/alert for disabled & members-only; replaces the body copy of the experimental alert."
          placeholder="Leave blank to use the default copy."
          autosize
          minRows={2}
          value={form.message}
          onChange={(e) => update({ message: e.currentTarget.value })}
        />
        <TargetInputs
          value={form}
          onChange={update}
          comboboxProps={comboboxProps}
          versionIdsDescription="Hidden and members-only versions leave the pickers; a disabled one stays selectable and refuses generation."
        />
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saveMutation.isPending}>
            Save rule
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const openGateRule = (rule?: GateRule) =>
  dialogStore.trigger({ component: GateRuleModal, props: { rule } });

const RULE_KIND_LABEL = new Map(
  RULE_KIND_OPTIONS.flatMap((group) => group.items).map((item) => [item.value, item.label])
);

function GateRuleCard({ rule, onDelete }: { rule: GateRule; onDelete: () => void }) {
  const badge = PRESENTATION_BADGE[rule.presentation];

  return (
    <Card withBorder padding="sm">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" className="min-w-0">
            <Badge color={badge.color} variant="light" className="shrink-0">
              {badge.label}
            </Badge>
            <Text size="sm" fw={600} truncate="end">
              {rule.name || 'Unnamed rule'}
            </Text>
          </Group>
          <Group gap={2} wrap="nowrap" className="shrink-0">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Edit rule"
              onClick={() => openGateRule(rule)}
            >
              <IconPencil size={16} />
            </ActionIcon>
            <ActionIcon variant="subtle" color="red" aria-label="Delete rule" onClick={onDelete}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        </Group>
        <Text size="xs">{RULE_KIND_LABEL.get(ruleKindValue(rule)) ?? rule.presentation}</Text>
        {rule.message && (
          <Text size="xs" c="dimmed">
            Message: “{rule.message}”
          </Text>
        )}
        <TargetDetails {...rule} emptyText="No targets — this rule does nothing" />
      </Stack>
    </Card>
  );
}

export function GateRulesSection() {
  const invalidate = useInvalidateGateRules();
  const { data, isLoading } = trpc.generation.getGateRules.useQuery();
  const deleteMutation = trpc.generation.deleteGateRule.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Deleted', message: 'Gate rule deleted.' });
      invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Delete failed', error: new Error(err.message) }),
  });

  const confirmDelete = (rule: GateRule) =>
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete gate rule?',
        message: (
          <Text size="sm">
            <b>{rule.name || 'Unnamed rule'}</b> stops applying as soon as caches refresh.
          </Text>
        ),
        labels: { cancel: 'Cancel', confirm: 'Delete' },
        confirmProps: { color: 'red' },
        // ConfirmDialog awaits this and never catches; onError already reports it.
        onConfirm: () => deleteMutation.mutateAsync({ id: rule.id }).catch(() => undefined),
      },
    });

  const rules = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end" wrap="nowrap">
        <Stack gap={2}>
          <Title order={3}>Gate rules</Title>
          <Text c="dimmed" size="sm">
            Each rule picks an outcome and attaches ecosystems, workflows, or model versions. When
            several rules hit one target the most restrictive wins (hidden &gt; disabled &gt;
            members-only).
          </Text>
        </Stack>
        <Button
          size="sm"
          variant="default"
          leftSection={<IconPlus size={16} />}
          onClick={() => openGateRule()}
          className="shrink-0"
        >
          Add rule
        </Button>
      </Group>

      {isLoading ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : rules.length === 0 ? (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          No gate rules yet. Add one to hide, disable, or flag ecosystems / workflows / versions.
        </Alert>
      ) : (
        <Stack gap="xs">
          {rules.map((rule) => (
            <GateRuleCard key={rule.id} rule={rule} onDelete={() => confirmDelete(rule)} />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
