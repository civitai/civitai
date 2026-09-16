import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Switch,
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
import type { GeneratorMessage, MessageAudience, MessageKind } from '~/shared/generation/messages';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  TargetDetails,
  TargetInputs,
  normalizeKeys,
  parseIds,
  type TargetValues,
} from './target-inputs';

const KIND_OPTIONS: { value: MessageKind; label: string }[] = [
  { value: 'pricing', label: 'Pricing — a cost change' },
  { value: 'maintenance', label: 'Maintenance — degraded, or scheduled work' },
  { value: 'info', label: 'Info — anything else' },
];

const KIND_BADGE: Record<MessageKind, { label: string; color: string }> = {
  pricing: { label: 'Pricing', color: 'yellow' },
  maintenance: { label: 'Maintenance', color: 'orange' },
  info: { label: 'Info', color: 'blue' },
};

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

const audienceText = (audiences: MessageAudience[]) =>
  audiences.length
    ? audiences.map((a) => AUDIENCE_OPTIONS.find((o) => o.value === a)?.label ?? a).join(', ')
    : 'Everyone';

type MessageForm = TargetValues & {
  id: string;
  name: string;
  kind: MessageKind;
  message: string;
  dismissible: boolean;
  audiences: MessageAudience[];
  createdAt?: number;
};

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg-${Date.now()}`;

const toForm = (message?: GeneratorMessage): MessageForm => ({
  id: message?.id ?? newId(),
  name: message?.name ?? '',
  kind: message?.kind ?? 'info',
  message: message?.message ?? '',
  dismissible: message?.dismissible ?? KIND_DISMISSIBLE.info,
  audiences: message?.audiences ?? [],
  ecosystems: message?.ecosystems ?? [],
  workflows: message?.workflows ?? [],
  modelVersionIds: message?.modelVersionIds.map(String) ?? [],
  createdAt: message?.createdAt,
});

function useInvalidateMessages() {
  const queryUtils = trpc.useUtils();
  return () => {
    queryUtils.generation.getGeneratorMessages.invalidate();
    queryUtils.generation.getGenerationConfig.invalidate();
  };
}

function GeneratorMessageModal({ message }: { message?: GeneratorMessage }) {
  const dialog = useDialogContext();
  const invalidate = useInvalidateMessages();
  const [form, setForm] = useState<MessageForm>(() => toForm(message));
  const update = (patch: Partial<MessageForm>) => setForm((f) => ({ ...f, ...patch }));
  // Inside a modal, dropdowns must portal or the modal body clips them.
  const comboboxProps = {
    withinPortal: true,
    zIndex: dialog.zIndex ? dialog.zIndex + 1 : undefined,
  };

  const saveMutation = trpc.generation.saveGeneratorMessage.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Saved',
        message: 'Generator message saved. Changes propagate as caches refresh.',
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
    if (!form.message.trim()) {
      showErrorNotification({
        title: 'Message is empty',
        error: new Error('Add the copy users should see.'),
      });
      return;
    }
    saveMutation.mutate({
      id: form.id,
      name: form.name.trim(),
      kind: form.kind,
      message: form.message.trim(),
      dismissible: form.dismissible,
      audiences: form.audiences,
      ecosystems: normalizeKeys(form.ecosystems),
      workflows: normalizeKeys(form.workflows),
      modelVersionIds: ids,
      createdAt: form.createdAt,
    });
  };

  return (
    <Modal
      {...dialog}
      title={<Text fw={600}>{message ? 'Edit generator message' : 'New generator message'}</Text>}
      size="lg"
    >
      <Stack gap="md">
        <TextInput
          label="Name"
          placeholder="e.g. MiniMax H3 price change"
          value={form.name}
          onChange={(e) => update({ name: e.currentTarget.value })}
          data-autofocus
        />
        <Select
          label="Kind"
          description="Sets the icon and tone, and the default for Dismissible."
          data={KIND_OPTIONS}
          value={form.kind}
          onChange={(v) =>
            v && update({ kind: v as MessageKind, dismissible: KIND_DISMISSIBLE[v as MessageKind] })
          }
          allowDeselect={false}
          comboboxProps={comboboxProps}
        />
        <Switch
          label="Dismissible"
          checked={form.dismissible}
          onChange={(e) => update({ dismissible: e.currentTarget.checked })}
        />
        <Textarea
          label="Message"
          description="Editing this re-shows the message to everyone who dismissed the previous wording."
          placeholder="e.g. MiniMax H3 pricing changes on the 15th."
          autosize
          minRows={3}
          required
          value={form.message}
          onChange={(e) => update({ message: e.currentTarget.value })}
        />
        <MultiSelect
          label="Audience"
          description="Anyone matching one of these. Empty = everyone."
          placeholder={form.audiences.length ? undefined : 'Everyone'}
          data={AUDIENCE_OPTIONS}
          value={form.audiences}
          onChange={(v) => update({ audiences: v as MessageAudience[] })}
          clearable
          comboboxProps={comboboxProps}
        />
        <TargetInputs value={form} onChange={update} comboboxProps={comboboxProps} />
        <Group justify="flex-end" gap="xs" mt="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saveMutation.isPending}>
            Save message
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const openMessage = (message?: GeneratorMessage) =>
  dialogStore.trigger({ component: GeneratorMessageModal, props: { message } });

function GeneratorMessageCard({
  message,
  onDelete,
}: {
  message: GeneratorMessage;
  onDelete: () => void;
}) {
  const badge = KIND_BADGE[message.kind];

  return (
    <Card withBorder padding="sm">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" className="min-w-0">
            <Badge color={badge.color} variant="light" className="shrink-0">
              {badge.label}
            </Badge>
            <Text size="sm" fw={600} truncate="end">
              {message.name || 'Unnamed message'}
            </Text>
            {message.dismissible && (
              <Badge size="xs" variant="outline" color="gray" className="shrink-0">
                dismissible
              </Badge>
            )}
          </Group>
          <Group gap={2} wrap="nowrap" className="shrink-0">
            <ActionIcon
              variant="subtle"
              color="gray"
              aria-label="Edit message"
              onClick={() => openMessage(message)}
            >
              <IconPencil size={16} />
            </ActionIcon>
            <ActionIcon variant="subtle" color="red" aria-label="Delete message" onClick={onDelete}>
              <IconTrash size={16} />
            </ActionIcon>
          </Group>
        </Group>
        <Text size="sm">{message.message}</Text>
        <Text size="xs" c="dimmed">
          Audience: {audienceText(message.audiences)}
        </Text>
        <TargetDetails {...message} emptyText="Every generation" />
      </Stack>
    </Card>
  );
}

export function GeneratorMessagesSection() {
  const invalidate = useInvalidateMessages();
  const { data: messages = [], isLoading } = trpc.generation.getGeneratorMessages.useQuery();
  const deleteMutation = trpc.generation.deleteGeneratorMessage.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Deleted', message: 'Generator message deleted.' });
      invalidate();
    },
    onError: (err) =>
      showErrorNotification({ title: 'Delete failed', error: new Error(err.message) }),
  });

  const confirmDelete = (message: GeneratorMessage) =>
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Delete generator message?',
        message: (
          <Text size="sm">
            <b>{message.name || 'Unnamed message'}</b> stops showing as soon as caches refresh.
          </Text>
        ),
        labels: { cancel: 'Cancel', confirm: 'Delete' },
        confirmProps: { color: 'red' },
        // ConfirmDialog awaits this and never catches; onError already reports it.
        onConfirm: () => deleteMutation.mutateAsync({ id: message.id }).catch(() => undefined),
      },
    });

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-end" wrap="nowrap">
        <Stack gap={2}>
          <Title order={3}>Generator messages</Title>
          <Text c="dimmed" size="sm">
            Shown above the Generate button — pricing changes, maintenance, anything to read before
            spending Buzz. Messages gate nothing; no targets means every generation.
          </Text>
        </Stack>
        <Button
          size="sm"
          variant="default"
          leftSection={<IconPlus size={16} />}
          onClick={() => openMessage()}
          className="shrink-0"
        >
          Add message
        </Button>
      </Group>

      {isLoading ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : messages.length === 0 ? (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
          No generator messages yet.
        </Alert>
      ) : (
        <Stack gap="xs">
          {messages.map((message) => (
            <GeneratorMessageCard
              key={message.id}
              message={message}
              onDelete={() => confirmDelete(message)}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
}
