/**
 * Moderator UI for generator-related runtime config (Redis-backed).
 *
 * All generation gating lives in the **Gate rules** section (the normalized
 * rules model). The self-hosted toggle is a separate card. `Experimental
 * ecosystems` is an alert flag, not a gate. Future generator config sections
 * should be added here rather than spawning new pages.
 *
 * The `testers` rule tier resolves via the `generation-testing` Flipt flag —
 * assign users to that flag in Flipt to grant testing access.
 */

import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  MultiSelect,
  Select,
  Stack,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconDeviceFloppy, IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';
import {
  GenerationStatusCard,
  SelfHostedGenerationStatusCard,
} from '~/components/Moderation/GenerationStatusCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ecosystemByKey, ecosystems } from '~/shared/constants/basemodel.constants';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import type {
  GateAvailableTo,
  GatePresentation,
  GateRule,
} from '~/shared/data-graph/generation/gates';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session.user?.isModerator)
      return { redirect: { destination: '/', permanent: false } };
    return { props: {} };
  },
});

/** Parse a TagsInput value (strings) into positive integers; returns the bad entries separately. */
function parseIds(values: string[] | undefined): { ids: number[]; invalid: string[] } {
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const raw of values ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n > 0) ids.push(n);
    else invalid.push(raw);
  }
  return { ids: Array.from(new Set(ids)), invalid };
}

/** Strip empty / whitespace-only entries and dedupe — keeps free-form keys as-is. */
function normalizeKeys(values: string[] | undefined): string[] {
  return Array.from(
    new Set((values ?? []).map((v) => v.trim()).filter((v): v is string => v.length > 0))
  );
}

function ExperimentalEcosystemsSection() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getEcosystemConfig.useQuery();

  const [experimentalEcosystems, setExperimentalEcosystems] = useState<string[]>([]);
  useEffect(() => {
    if (!data) return;
    setExperimentalEcosystems(data.experimentalEcosystems ?? []);
  }, [data]);

  // Plain ecosystem keys for the TagsInput; the dropdown is dressed up via
  // `renderOption`. Free-form entries are accepted, so any key works.
  const ecosystemSuggestions = useMemo(
    () => [...ecosystems].sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.key),
    []
  );

  const renderEcosystemOption = useCallback(({ option }: { option: { value: string } }) => {
    const eco = ecosystemByKey.get(option.value);
    if (!eco) return option.value;
    return (
      <span>
        <Text span fw={500}>
          {eco.displayName}
        </Text>{' '}
        <Text span c="dimmed" size="xs">
          ({option.value})
        </Text>
      </span>
    );
  }, []);

  const setMutation = trpc.generation.setEcosystemConfig.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Experimental ecosystems updated. Changes propagate as caches refresh.',
      });
      queryUtils.generation.getEcosystemConfig.invalidate();
      queryUtils.generation.getGenerationConfig.invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Save failed', error: new Error(err.message) }),
  });

  if (isLoading) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={3}>Experimental ecosystems</Title>
        <Text c="dimmed" size="sm">
          Shows the &ldquo;experimental build&rdquo; alert in the generator UI. This is{' '}
          <b>not a gate</b> — it doesn&apos;t restrict access. All gating now lives in{' '}
          <b>Gate rules</b> below.
        </Text>
      </Stack>

      <TagsInput
        label="Experimental ecosystems"
        description="Unioned with the static experimental flag baked into base-model records."
        placeholder="Pick or type an ecosystem key…"
        data={ecosystemSuggestions}
        renderOption={renderEcosystemOption}
        value={experimentalEcosystems}
        onChange={setExperimentalEcosystems}
        splitChars={[',', ' ']}
        acceptValueOnBlur
        clearable
      />

      <Group justify="flex-end">
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={() =>
            setMutation.mutate({ experimentalEcosystems: normalizeKeys(experimentalEcosystems) })
          }
          loading={setMutation.isPending}
        >
          Save experimental ecosystems
        </Button>
      </Group>
    </Stack>
  );
}

// =============================================================================
// Gate rules (the normalized rules model)
// =============================================================================

// Editing shape: `modelVersionIds` are strings here (TagsInput) and parsed to
// numbers on save, mirroring the ecosystem-config ID handling.
type RuleForm = {
  id: string;
  name: string;
  availableTo: GateAvailableTo;
  presentation: GatePresentation;
  message: string;
  ecosystems: string[];
  workflows: string[];
  modelVersionIds: string[];
};

// Positive "available to" framing: the named tier keeps access, everyone else is
// gated. "Available to testers, hidden" === the legacy "testers enabled, others
// hidden by default".
const AVAILABLE_TO_OPTIONS: { value: GateAvailableTo; label: string }[] = [
  { value: 'moderators', label: 'Moderators only' },
  { value: 'testers', label: 'Testers (generation-testing flag) + mods' },
  { value: 'members', label: 'Members + mods' },
  { value: 'nobody', label: 'Nobody (kill-switch — off for everyone, mods included)' },
];

const PRESENTATION_OPTIONS: { value: GatePresentation; label: string }[] = [
  { value: 'disabled', label: 'Disabled — shown but greyed out' },
  { value: 'hidden', label: 'Hidden — removed entirely' },
];

const newRuleId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rule-${Date.now()}`;

const emptyRule = (): RuleForm => ({
  id: newRuleId(),
  name: '',
  availableTo: 'members',
  presentation: 'disabled',
  message: '',
  ecosystems: [],
  workflows: [],
  modelVersionIds: [],
});

function GateRulesSection() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getGateRules.useQuery();
  const [rules, setRules] = useState<RuleForm[]>([]);

  useEffect(() => {
    if (!data) return;
    setRules(
      data.map((r) => ({
        id: r.id,
        name: r.name,
        availableTo: r.availableTo,
        presentation: r.presentation,
        message: r.message ?? '',
        ecosystems: r.ecosystems,
        workflows: r.workflows,
        modelVersionIds: r.modelVersionIds.map(String),
      }))
    );
  }, [data]);

  const ecosystemSuggestions = useMemo(
    () => [...ecosystems].sort((a, b) => a.sortOrder - b.sortOrder).map((e) => e.key),
    []
  );

  // Workflow options by name (stored by key). Include any key already on a rule
  // that's no longer in the config so it stays visible/removable.
  const workflowOptions = useMemo(() => {
    const labelByKey = new Map<string, string>();
    for (const [key, config] of workflowConfigByKey) labelByKey.set(key, config.label ?? key);
    for (const rule of rules)
      for (const key of rule.workflows) if (!labelByKey.has(key)) labelByKey.set(key, key);
    return [...labelByKey.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rules]);

  const renderEcosystemOption = useCallback(({ option }: { option: { value: string } }) => {
    const eco = ecosystemByKey.get(option.value);
    if (!eco) return option.value;
    return (
      <span>
        <Text span fw={500}>
          {eco.displayName}
        </Text>{' '}
        <Text span c="dimmed" size="xs">
          ({option.value})
        </Text>
      </span>
    );
  }, []);

  const updateRule = (id: string, patch: Partial<RuleForm>) =>
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const setMutation = trpc.generation.setGateRules.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Gate rules updated. Changes propagate as caches refresh.',
      });
      queryUtils.generation.getGateRules.invalidate();
      queryUtils.generation.getGenerationConfig.invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Save failed', error: new Error(err.message) }),
  });

  const handleSave = () => {
    const allInvalid: string[] = [];
    const payload: GateRule[] = rules.map((r) => {
      const { ids, invalid } = parseIds(r.modelVersionIds);
      allInvalid.push(...invalid);
      return {
        id: r.id,
        name: r.name.trim(),
        availableTo: r.availableTo,
        presentation: r.presentation,
        message: r.message.trim() || undefined,
        ecosystems: normalizeKeys(r.ecosystems),
        workflows: normalizeKeys(r.workflows),
        modelVersionIds: ids,
      };
    });

    if (allInvalid.length) {
      showErrorNotification({
        title: 'Invalid model version IDs',
        error: new Error(`Not positive integers: ${allInvalid.join(', ')}`),
      });
      return;
    }

    setMutation.mutate(payload);
  };

  if (isLoading) {
    return (
      <Group justify="center" py="xl">
        <Loader />
      </Group>
    );
  }

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Title order={3}>Gate rules</Title>
        <Text c="dimmed" size="sm">
          The normalized gating model: each rule names <b>who keeps access</b> (available to) and{' '}
          <b>how it appears to everyone else</b> (presentation), then attaches any mix of
          ecosystems, workflows, and model version IDs. &ldquo;Available to testers, hidden&rdquo;
          is the old &ldquo;testers enabled, others hidden&rdquo;. The most restrictive state wins
          (hidden &gt; disabled &gt; members-only).
        </Text>
        <Text c="dimmed" size="sm">
          <b>Available to members + Disabled</b> renders as the members-only upsell (you can become
          a member). Other tiers just grey out. The optional message is extra copy shown on top of
          the standard badge/alert — it never replaces it.
        </Text>
      </Stack>

      {rules.length === 0 && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          No gate rules yet. Add one to gate ecosystems / workflows / versions without touching the
          legacy lists above.
        </Alert>
      )}

      <Stack gap="md">
        {rules.map((rule) => {
          const isUpsell = rule.presentation === 'disabled' && rule.availableTo === 'members';
          return (
            <Card key={rule.id} withBorder padding="md">
              <Stack gap="sm">
                <Group align="flex-end" wrap="nowrap">
                  <TextInput
                    label="Name"
                    placeholder="e.g. Maintenance window"
                    value={rule.name}
                    onChange={(e) => updateRule(rule.id, { name: e.currentTarget.value })}
                    className="flex-1"
                  />
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    size="lg"
                    aria-label="Remove rule"
                    onClick={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}
                  >
                    <IconTrash size={18} />
                  </ActionIcon>
                </Group>
                <Group grow align="flex-start">
                  <Select
                    label="Available to"
                    data={AVAILABLE_TO_OPTIONS}
                    value={rule.availableTo}
                    onChange={(v) =>
                      v && updateRule(rule.id, { availableTo: v as GateAvailableTo })
                    }
                    allowDeselect={false}
                  />
                  <Select
                    label="Presentation"
                    data={PRESENTATION_OPTIONS}
                    value={rule.presentation}
                    onChange={(v) =>
                      v && updateRule(rule.id, { presentation: v as GatePresentation })
                    }
                    allowDeselect={false}
                  />
                </Group>
                {isUpsell && (
                  <Text size="xs" c="yellow.7">
                    Resolves to the members-only upsell (Become-a-member CTA).
                  </Text>
                )}
                <Textarea
                  label="Message (optional)"
                  description="Extra copy layered on the standard badge/alert for disabled & members-only."
                  placeholder="Leave blank to use the default copy."
                  autosize
                  minRows={1}
                  value={rule.message}
                  onChange={(e) => updateRule(rule.id, { message: e.currentTarget.value })}
                />
                <TagsInput
                  label="Ecosystems"
                  placeholder="Pick or type an ecosystem key…"
                  data={ecosystemSuggestions}
                  renderOption={renderEcosystemOption}
                  value={rule.ecosystems}
                  onChange={(v) => updateRule(rule.id, { ecosystems: v })}
                  splitChars={[',', ' ']}
                  acceptValueOnBlur
                  clearable
                />
                <MultiSelect
                  label="Workflows"
                  placeholder="Pick a workflow…"
                  data={workflowOptions}
                  value={rule.workflows}
                  onChange={(v) => updateRule(rule.id, { workflows: v })}
                  searchable
                  clearable
                />
                <TagsInput
                  label="Model version IDs"
                  description="Numeric model version IDs. Version pickers can't show-disable, so any gated version is hidden."
                  placeholder="e.g. 12345"
                  value={rule.modelVersionIds}
                  onChange={(v) => updateRule(rule.id, { modelVersionIds: v })}
                  splitChars={[',', ' ']}
                  clearable
                />
              </Stack>
            </Card>
          );
        })}
      </Stack>

      <Group justify="space-between">
        <Button
          variant="default"
          leftSection={<IconPlus size={16} />}
          onClick={() => setRules((rs) => [...rs, emptyRule()])}
        >
          Add rule
        </Button>
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          loading={setMutation.isPending}
        >
          Save gate rules
        </Button>
      </Group>
    </Stack>
  );
}

function GenerationConfigPage() {
  return (
    <>
      <Meta title="Generation Config" deIndex />
      <Container size="md" py="lg">
        <Stack gap="xl">
          <Stack gap={4}>
            <Title order={2}>Generation Config</Title>
            <Text c="dimmed" size="sm">
              Runtime configuration for the generator. Each section saves independently.
            </Text>
          </Stack>

          <GenerationStatusCard />

          <Divider />

          <SelfHostedGenerationStatusCard />

          <Divider />

          <GateRulesSection />

          <Divider />

          <ExperimentalEcosystemsSection />
        </Stack>
      </Container>
    </>
  );
}

export default Page(GenerationConfigPage);
