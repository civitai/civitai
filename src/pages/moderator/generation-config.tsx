/**
 * Moderator UI for generator-related runtime config (Redis-backed).
 *
 * All generation gating lives in the **Gate rules** section (the normalized
 * rules model), which also carries the non-gating `experimental` presentation.
 * Standalone announcements are **Generator messages**, a separate store.
 * The self-hosted toggle is a separate card. Future generator config sections
 * should be added here rather than spawning new pages.
 *
 * The `testers` rule tier resolves via the `generation-testing` Flipt flag —
 * assign users to that flag in Flipt to grant testing access.
 */

import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  MultiSelect,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconDeviceFloppy, IconInfoCircle, IconPlus, IconTrash } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
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
import type { GeneratorMessage, MessageAudience, MessageKind } from '~/shared/generation/messages';
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

// =============================================================================
// Target inputs — shared by gate rules and generator messages
// =============================================================================

const ECOSYSTEM_SUGGESTIONS = [...ecosystems]
  .sort((a, b) => a.sortOrder - b.sortOrder)
  .map((e) => e.key);

const renderEcosystemOption = ({ option }: { option: { value: string } }) => {
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
};

/**
 * Workflow options by name (stored by key). Any key already saved but no longer
 * in the config stays listed, so it remains visible and removable.
 */
function useWorkflowOptions(attachedKeys: string[]) {
  const fingerprint = attachedKeys.join(',');
  return useMemo(() => {
    const labelByKey = new Map<string, string>();
    for (const [key, config] of workflowConfigByKey) labelByKey.set(key, config.label ?? key);
    for (const key of attachedKeys) if (!labelByKey.has(key)) labelByKey.set(key, key);
    return [...labelByKey.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- attachedKeys is rebuilt each render; compare by value
  }, [fingerprint]);
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

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function targetSummary(rule: RuleForm): string {
  const parts = [
    rule.ecosystems.length && plural(rule.ecosystems.length, 'ecosystem'),
    rule.workflows.length && plural(rule.workflows.length, 'workflow'),
    rule.modelVersionIds.length && plural(rule.modelVersionIds.length, 'version'),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : 'No targets — this rule does nothing';
}

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

  const workflowOptions = useWorkflowOptions(rules.flatMap((r) => r.workflows));

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
        // Experimental has no exempt tier; pin it so an older stored
        // `availableTo` the UI no longer offers can't survive a save.
        availableTo: r.presentation === 'experimental' ? 'nobody' : r.availableTo,
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
          Each rule picks one <b>outcome</b> — what a gated user sees, and who is exempt from it —
          then attaches any mix of ecosystems, workflows, and model version IDs. When several rules
          hit one target the most restrictive wins (hidden &gt; disabled &gt; members-only).
        </Text>
        <Text c="dimmed" size="sm">
          <b>Experimental</b> is not a gate: it warns without blocking and applies to everyone. The
          optional message is extra copy on top of the standard badge/alert for the two real gates,
          and replaces the body copy of the experimental alert. For standalone announcements, use{' '}
          <b>Generator messages</b> below.
        </Text>
      </Stack>

      {rules.length === 0 && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          No gate rules yet. Add one to hide, disable, or flag ecosystems / workflows / versions.
        </Alert>
      )}

      <Stack gap="md">
        {rules.map((rule) => {
          const badge = PRESENTATION_BADGE[rule.presentation];
          return (
            <Card key={rule.id} withBorder padding="md">
              <Stack gap="sm">
                <Group justify="space-between" wrap="nowrap">
                  <Badge color={badge.color} variant="light">
                    {badge.label}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {targetSummary(rule)}
                  </Text>
                </Group>
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
                <Select
                  label="Rule"
                  data={RULE_KIND_OPTIONS}
                  value={ruleKindValue(rule)}
                  onChange={(v) => v && updateRule(rule.id, parseRuleKind(v))}
                  allowDeselect={false}
                />
                <Textarea
                  label="Message (optional)"
                  description="Extra copy layered on the standard badge/alert for disabled & members-only; replaces the body copy of the experimental alert."
                  placeholder="Leave blank to use the default copy."
                  autosize
                  minRows={1}
                  value={rule.message}
                  onChange={(e) => updateRule(rule.id, { message: e.currentTarget.value })}
                />
                <TagsInput
                  label="Ecosystems"
                  placeholder="Pick or type an ecosystem key…"
                  data={ECOSYSTEM_SUGGESTIONS}
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
                  description="Numeric model version IDs. Hidden and members-only versions leave the pickers; a disabled one stays selectable and refuses generation."
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

// =============================================================================
// Generator messages (a separate store — messages gate nothing)
// =============================================================================

type MessageForm = {
  id: string;
  name: string;
  kind: MessageKind;
  message: string;
  dismissible: boolean;
  audiences: MessageAudience[];
  ecosystems: string[];
  workflows: string[];
  modelVersionIds: string[];
};

const KIND_OPTIONS: { value: MessageKind; label: string }[] = [
  { value: 'pricing', label: 'Pricing — a cost change' },
  { value: 'maintenance', label: 'Maintenance — degraded, or scheduled work' },
  { value: 'info', label: 'Info — anything else' },
];

/** Per-kind default; the Switch overrides it per message. */
const KIND_DISMISSIBLE: Record<MessageKind, boolean> = {
  pricing: true,
  maintenance: false,
  info: true,
};

const AUDIENCE_OPTIONS: { value: MessageAudience; label: string }[] = [
  { value: 'members', label: 'Members' },
  { value: 'nonMembers', label: 'Non-members' },
  { value: 'free', label: 'Free' },
  { value: 'founder', label: 'Founder' },
  { value: 'bronze', label: 'Bronze' },
  { value: 'silver', label: 'Silver' },
  { value: 'gold', label: 'Gold' },
];

const emptyMessage = (): MessageForm => ({
  id: newRuleId(),
  name: '',
  kind: 'info',
  message: '',
  dismissible: KIND_DISMISSIBLE.info,
  audiences: [],
  ecosystems: [],
  workflows: [],
  modelVersionIds: [],
});

function messageTargetSummary(message: MessageForm): string {
  const parts = [
    message.ecosystems.length && plural(message.ecosystems.length, 'ecosystem'),
    message.workflows.length && plural(message.workflows.length, 'workflow'),
    message.modelVersionIds.length && plural(message.modelVersionIds.length, 'version'),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(' · ') : 'Every generation';
}

function GeneratorMessagesSection() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.generation.getGeneratorMessages.useQuery();
  const [messages, setMessages] = useState<MessageForm[]>([]);

  useEffect(() => {
    if (!data) return;
    setMessages(
      data.map((m) => ({
        id: m.id,
        name: m.name,
        kind: m.kind,
        message: m.message,
        dismissible: m.dismissible,
        audiences: m.audiences,
        ecosystems: m.ecosystems,
        workflows: m.workflows,
        modelVersionIds: m.modelVersionIds.map(String),
      }))
    );
  }, [data]);

  const workflowOptions = useWorkflowOptions(messages.flatMap((m) => m.workflows));

  const updateMessage = (id: string, patch: Partial<MessageForm>) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const setMutation = trpc.generation.setGeneratorMessages.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Generator messages updated. Changes propagate as caches refresh.',
      });
      queryUtils.generation.getGeneratorMessages.invalidate();
      queryUtils.generation.getGenerationConfig.invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Save failed', error: new Error(err.message) }),
  });

  const handleSave = () => {
    const allInvalid: string[] = [];
    const payload: GeneratorMessage[] = messages.map((m) => {
      const { ids, invalid } = parseIds(m.modelVersionIds);
      allInvalid.push(...invalid);
      return {
        id: m.id,
        name: m.name.trim(),
        kind: m.kind,
        message: m.message.trim(),
        dismissible: m.dismissible,
        audiences: m.audiences,
        ecosystems: normalizeKeys(m.ecosystems),
        workflows: normalizeKeys(m.workflows),
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

    const empty = payload.filter((m) => !m.message);
    if (empty.length) {
      showErrorNotification({
        title: 'Every message needs copy',
        error: new Error(
          `Add a message to: ${empty.map((m) => m.name || 'Unnamed message').join(', ')}`
        ),
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
        <Title order={3}>Generator messages</Title>
        <Text c="dimmed" size="sm">
          Announcements shown <b>above the Generate button</b> — pricing changes, maintenance,
          anything a user should read before spending Buzz. These gate nothing: use a gate rule to
          block generation.
        </Text>
        <Text c="dimmed" size="sm">
          Leave every target empty to show a message on <b>every</b> generation. Leave the audience
          empty to show it to everyone.
        </Text>
      </Stack>

      {messages.length === 0 && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          No generator messages yet.
        </Alert>
      )}

      <Stack gap="md">
        {messages.map((message) => (
          <Card key={message.id} withBorder padding="md">
            <Stack gap="sm">
              <Group justify="space-between" wrap="nowrap">
                <Badge color="blue" variant="light">
                  {KIND_OPTIONS.find((k) => k.value === message.kind)?.label ?? message.kind}
                </Badge>
                <Text size="xs" c="dimmed">
                  {messageTargetSummary(message)}
                </Text>
              </Group>
              <Group align="flex-end" wrap="nowrap">
                <TextInput
                  label="Name"
                  placeholder="e.g. MiniMax H3 price change"
                  value={message.name}
                  onChange={(e) => updateMessage(message.id, { name: e.currentTarget.value })}
                  className="flex-1"
                />
                <ActionIcon
                  color="red"
                  variant="subtle"
                  size="lg"
                  aria-label="Remove message"
                  onClick={() => setMessages((ms) => ms.filter((m) => m.id !== message.id))}
                >
                  <IconTrash size={18} />
                </ActionIcon>
              </Group>
              <Group align="flex-end" wrap="nowrap">
                <Select
                  label="Kind"
                  data={KIND_OPTIONS}
                  value={message.kind}
                  onChange={(v) =>
                    v &&
                    updateMessage(message.id, {
                      kind: v as MessageKind,
                      dismissible: KIND_DISMISSIBLE[v as MessageKind],
                    })
                  }
                  allowDeselect={false}
                  className="flex-1"
                />
                <Switch
                  label="Dismissible"
                  checked={message.dismissible}
                  onChange={(e) =>
                    updateMessage(message.id, { dismissible: e.currentTarget.checked })
                  }
                  mb={8}
                />
              </Group>
              <Textarea
                label="Message"
                description="Editing this re-shows the message to everyone who dismissed the previous wording."
                placeholder="e.g. MiniMax H3 pricing changes on the 15th."
                autosize
                minRows={2}
                required
                value={message.message}
                onChange={(e) => updateMessage(message.id, { message: e.currentTarget.value })}
              />
              <MultiSelect
                label="Audience"
                description="Anyone matching one of these. Empty = everyone."
                placeholder="Everyone"
                data={AUDIENCE_OPTIONS}
                value={message.audiences}
                onChange={(v) => updateMessage(message.id, { audiences: v as MessageAudience[] })}
                clearable
              />
              <TagsInput
                label="Ecosystems"
                placeholder="Pick or type an ecosystem key…"
                data={ECOSYSTEM_SUGGESTIONS}
                renderOption={renderEcosystemOption}
                value={message.ecosystems}
                onChange={(v) => updateMessage(message.id, { ecosystems: v })}
                splitChars={[',', ' ']}
                acceptValueOnBlur
                clearable
              />
              <MultiSelect
                label="Workflows"
                placeholder="Pick a workflow…"
                data={workflowOptions}
                value={message.workflows}
                onChange={(v) => updateMessage(message.id, { workflows: v })}
                searchable
                clearable
              />
              <TagsInput
                label="Model version IDs"
                placeholder="e.g. 12345"
                value={message.modelVersionIds}
                onChange={(v) => updateMessage(message.id, { modelVersionIds: v })}
                splitChars={[',', ' ']}
                clearable
              />
            </Stack>
          </Card>
        ))}
      </Stack>

      <Group justify="space-between">
        <Button
          variant="default"
          leftSection={<IconPlus size={16} />}
          onClick={() => setMessages((ms) => [...ms, emptyMessage()])}
        >
          Add message
        </Button>
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          loading={setMutation.isPending}
        >
          Save messages
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

          <GeneratorMessagesSection />
        </Stack>
      </Container>
    </>
  );
}

export default Page(GenerationConfigPage);
