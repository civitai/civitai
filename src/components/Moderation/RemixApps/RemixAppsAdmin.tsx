import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import { useMemo, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { DEFAULT_ENGINE } from '~/shared/constants/remix-apps.constants';
import type { RemixAnswer } from '~/shared/remix-apps/define';
import {
  REMIX_SAVABLE_SLOT_IDS,
  remixAppInputSchema,
  type RemixAppInput,
} from '~/shared/remix-apps/row.schema';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type AdminRow = RouterOutput['remixApp']['admin']['list'][number];

const NEW_APP: RemixAppInput = {
  slug: 'new-app',
  name: 'New app',
  target: 'image.remix',
  spec: {
    icon: 'sparkles',
    engine: DEFAULT_ENGINE,
    asks: [],
    steps: [
      {
        kind: 'image',
        prompt: "Redraw this image as ... Don't add any text or lettering.",
        aspectRatio: 'source',
        quantity: 1,
        input: 'source',
      },
    ],
  },
};

function describeSpec(input: RemixAppInput) {
  const { spec } = input;
  if ('code' in spec) return `code: ${spec.code}`;
  const asks = spec.asks.map((a) => a.kind).join(', ');
  const steps = spec.steps.map((s) => s.kind).join(' → ');
  return asks ? `asks ${asks}; ${steps}` : steps;
}

/** The mod list of remix apps: add, edit, enable, order and test-run them. */
export function RemixAppsAdmin() {
  const utils = trpc.useUtils();
  const { data: rows = [], isLoading } = trpc.remixApp.admin.list.useQuery();
  const [editing, setEditing] = useState<RemixAppInput | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const refresh = () => utils.remixApp.admin.list.invalidate();
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Not saved', error: new Error(error.message) });
  const setEnabled = trpc.remixApp.admin.setEnabled.useMutation({ onSuccess: refresh, onError });
  const order = trpc.remixApp.admin.order.useMutation({ onSuccess: refresh, onError });
  const remove = trpc.remixApp.admin.delete.useMutation({ onSuccess: refresh, onError });
  const confirmDelete = (slug: string) =>
    openConfirmModal({
      title: `Delete ${slug}?`,
      children: (
        <Text size="sm">
          This removes the app row for good, and with it any installs of it. It cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ slug }),
    });

  const move = (index: number, by: -1 | 1) => {
    const slugs = rows.map((r) => r.slug);
    const [slug] = slugs.splice(index, 1);
    slugs.splice(index + by, 0, slug);
    order.mutate({ slugs });
  };

  return (
    <>
      <RemixAppsList
        rows={rows}
        isLoading={isLoading}
        onAdd={() => setEditing(NEW_APP)}
        onMove={move}
        onToggle={(slug, enabled) => setEnabled.mutate({ slug, enabled })}
        onEdit={setEditing}
        onTest={setTesting}
        onDelete={confirmDelete}
      />
      {editing && (
        <RemixAppEditor
          initial={editing}
          isNew={!rows.some((r) => r.slug === editing.slug)}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {testing && <RemixAppTestRun slug={testing} onClose={() => setTesting(null)} />}
    </>
  );
}

export function RemixAppsList({
  rows,
  isLoading,
  onAdd,
  onMove,
  onToggle,
  onEdit,
  onTest,
  onDelete,
}: {
  rows: AdminRow[];
  isLoading: boolean;
  onAdd: () => void;
  onMove: (index: number, by: -1 | 1) => void;
  onToggle: (slug: string, enabled: boolean) => void;
  onEdit: (input: RemixAppInput) => void;
  onTest: (slug: string) => void;
  onDelete: (slug: string) => void;
}) {
  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <Stack gap={4}>
          <Title order={2}>Remix apps</Title>
          <Text c="dimmed" size="sm">
            What the image Remix menu lists, in this order. A new app starts disabled: test-run it,
            then enable it. Prices are never stored; every run quotes live.
          </Text>
        </Stack>
        <Button leftSection={<IconPlus size={16} />} onClick={onAdd}>
          Add app
        </Button>
      </Group>

      {!isLoading && rows.length === 0 && (
        <Alert color="yellow" title="No rows yet">
          The menu is serving the built-in seed apps. Apply the remix apps seed migration to this
          database to edit them here.
        </Alert>
      )}

      <Table striped verticalSpacing="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th w={70}>Order</Table.Th>
            <Table.Th>App</Table.Th>
            <Table.Th>Runs</Table.Th>
            <Table.Th>Version</Table.Th>
            <Table.Th>Listed</Table.Th>
            <Table.Th w={120} />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, index) => (
            <AdminTableRow
              key={row.slug}
              row={row}
              first={index === 0}
              last={index === rows.length - 1}
              onMove={(by) => onMove(index, by)}
              onToggle={(enabled) => onToggle(row.slug, enabled)}
              onEdit={() => 'input' in row && row.input && onEdit(row.input)}
              onTest={() => onTest(row.slug)}
              onDelete={() => onDelete(row.slug)}
            />
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function AdminTableRow({
  row,
  first,
  last,
  onMove,
  onToggle,
  onEdit,
  onTest,
  onDelete,
}: {
  row: AdminRow;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
}) {
  const input = 'input' in row ? row.input : undefined;
  return (
    <Table.Tr>
      <Table.Td>
        <Group gap={2} wrap="nowrap">
          <ActionIcon variant="subtle" disabled={first} onClick={() => onMove(-1)} aria-label="Up">
            <IconArrowUp size={14} />
          </ActionIcon>
          <ActionIcon variant="subtle" disabled={last} onClick={() => onMove(1)} aria-label="Down">
            <IconArrowDown size={14} />
          </ActionIcon>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text fw={600} size="sm">
          {input?.name ?? row.slug}
        </Text>
        <Text size="xs" c="dimmed">
          {row.slug} · {input?.target ?? '—'}
        </Text>
      </Table.Td>
      <Table.Td>
        {input ? (
          <Text size="xs">{describeSpec(input)}</Text>
        ) : (
          <Badge
            color="red"
            variant="light"
            title={'invalid' in row ? row.invalid?.join('\n') : ''}
          >
            Invalid, not served
          </Badge>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="xs">{row.version}</Text>
      </Table.Td>
      <Table.Td>
        <Switch
          checked={row.enabled}
          onChange={(e) => onToggle(e.currentTarget.checked)}
          aria-label={`List ${row.slug}`}
        />
      </Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <ActionIcon variant="light" onClick={onEdit} disabled={!input} aria-label="Edit">
            <IconPencil size={14} />
          </ActionIcon>
          <ActionIcon variant="light" color="green" onClick={onTest} aria-label="Test run">
            <IconPlayerPlay size={14} />
          </ActionIcon>
          {row.deletable && (
            <ActionIcon variant="light" color="red" onClick={onDelete} aria-label="Delete">
              <IconTrash size={14} />
            </ActionIcon>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

function RemixAppEditor({
  initial,
  isNew,
  onClose,
  onSaved,
}: {
  initial: RemixAppInput;
  isNew: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [slug, setSlug] = useState(initial.slug);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [target, setTarget] = useState<string>(initial.target);
  const [specText, setSpecText] = useState(JSON.stringify(initial.spec, null, 2));

  // The server runs the same schema, and also checks the slug and the target.
  const parsed = useMemo(() => {
    let spec: unknown;
    try {
      spec = JSON.parse(specText);
    } catch (error) {
      return { issues: [`spec: ${(error as Error).message}`] };
    }
    const result = remixAppInputSchema.safeParse({
      slug,
      name,
      description: description || undefined,
      target,
      spec,
    });
    return result.success
      ? { input: result.data }
      : { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }, [slug, name, description, target, specText]);

  const save = trpc.remixApp.admin.save.useMutation({
    onSuccess: ({ version }) => {
      showSuccessNotification({ message: `Saved ${slug}, run version ${version}` });
      onSaved();
      onClose();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Not saved', error: new Error(error.message) }),
  });

  return (
    <Modal
      opened
      onClose={onClose}
      title={isNew ? 'Add remix app' : `Edit ${initial.name}`}
      size="xl"
    >
      <Stack gap="sm">
        <Group grow>
          <TextInput
            label="Slug"
            value={slug}
            disabled={!isNew}
            onChange={(e) => setSlug(e.currentTarget.value)}
          />
          <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Select
            label="Shows on"
            // A stored row keeps its slot, even one new apps cannot take, so it can still be saved.
            data={[...new Set<string>([...REMIX_SAVABLE_SLOT_IDS, initial.target])]}
            value={target}
            onChange={(value) => value && setTarget(value)}
          />
        </Group>
        {target === 'video.remix' && (
          <Text size="xs" c="yellow">
            No video remix surface exists yet: a video app validates but shows nowhere.
          </Text>
        )}
        <TextInput
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
        <Textarea
          label="Spec"
          description="icon, engine, asks and steps. A prompt fills {{name}} from a text ask's id or a choice option's fragments. Changing asks, steps or engine bumps the run version."
          autosize
          minRows={12}
          maxRows={28}
          styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
          value={specText}
          onChange={(e) => setSpecText(e.currentTarget.value)}
        />
        {'issues' in parsed && parsed.issues ? (
          <Alert color="red" title="Not valid yet">
            <Stack gap={2}>
              {parsed.issues.map((issue) => (
                <Code key={issue}>{issue}</Code>
              ))}
            </Stack>
          </Alert>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!('input' in parsed)}
            loading={save.isPending}
            onClick={() => 'input' in parsed && parsed.input && save.mutate(parsed.input)}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type TestState = RouterOutput['remixApp']['admin']['testStart'];

/**
 * Runs the app on an image as this mod, disabled or not. Every step is quoted first; Buzz is spent
 * only by the Confirm button, which sends the quote it shows.
 */
function RemixAppTestRun({ slug, onClose }: { slug: string; onClose: () => void }) {
  const [imageId, setImageId] = useState<number | string>('');
  const [nonce] = useState(() => `test-${Math.random().toString(36).slice(2, 12)}`);
  const [answers, setAnswers] = useState<RemixAnswer[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<TestState | null>(null);
  const start = trpc.remixApp.admin.testStart.useMutation({
    onSuccess: setState,
    onError: (error) =>
      showErrorNotification({ title: 'Test run', error: new Error(error.message) }),
  });
  const ready = typeof imageId === 'number' && imageId > 0;
  const quote = (next: RemixAnswer[]) => {
    setAnswers(next);
    if (ready) start.mutate({ slug, imageId, nonce, answers: next });
  };

  return (
    <Modal opened onClose={onClose} title={`Test run: ${slug}`} size="md">
      <Stack gap="sm">
        <Text size="xs" c="dimmed">
          Runs as you, on your Buzz. Nothing is spent until you press Confirm.
        </Text>
        <Group align="flex-end">
          <NumberInput
            label="Image id"
            value={imageId}
            onChange={setImageId}
            min={1}
            hideControls
            style={{ flex: 1 }}
          />
          <Button disabled={!ready} loading={start.isPending} onClick={() => quote([])}>
            Quote
          </Button>
        </Group>

        {state?.status === 'ask' && state.ask.kind === 'choice' && (
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              {state.ask.prompt}
            </Text>
            <Group gap={6}>
              {state.ask.options.map((o) => (
                <Button
                  key={o.value}
                  size="xs"
                  variant="light"
                  onClick={() => quote([...answers, o.value])}
                >
                  {o.label}
                  {state.prices?.[o.value] != null && ` · ${state.prices[o.value]}`}
                </Button>
              ))}
            </Group>
          </Stack>
        )}
        {state?.status === 'ask' && state.ask.kind === 'text' && (
          <Group align="flex-end">
            <TextInput
              label={state.ask.prompt}
              value={text}
              maxLength={state.ask.maxLength}
              onChange={(e) => setText(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
            <Button size="xs" onClick={() => quote([...answers, text])}>
              {text ? 'Answer' : 'Skip'}
            </Button>
          </Group>
        )}
        {state?.status === 'priced' && ready && (
          <Group justify="space-between">
            <Group gap={6}>
              <Text size="sm">First step costs</Text>
              <CurrencyBadge currency="BUZZ" unitAmount={state.cost} />
            </Group>
            <Button
              color="green"
              loading={start.isPending}
              onClick={() => start.mutate({ slug, imageId, nonce, answers, quote: state.cost })}
            >
              Confirm and run
            </Button>
          </Group>
        )}
        {state?.status === 'running' && (
          <Alert color="green">
            Started. Follow it, answer its asks and post it from the Remix tray.
          </Alert>
        )}
        {state?.status === 'failed' && <Alert color="red">{state.reason}</Alert>}
      </Stack>
    </Modal>
  );
}
