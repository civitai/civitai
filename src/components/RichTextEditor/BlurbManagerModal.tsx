import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  CloseButton,
  Drawer,
  Group,
  Loader,
  Menu,
  Modal,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBulb,
  IconDotsVertical,
  IconLock,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconRepeat,
  IconTrash,
} from '@tabler/icons-react';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { showNotification } from '@mantine/notifications';
import clsx from 'clsx';
import type { MouseEvent } from 'react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditorComponent';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { blurbPreview } from '~/components/RichTextEditor/blurb.util';
import { useIsMobile } from '~/hooks/useIsMobile';
import { MAX_BLURB_LENGTH } from '~/server/schema/blurb.schema';
import { MAX_BLURBS_PER_USER } from '~/shared/constants/blurb.constants';
import { showErrorNotification } from '~/utils/notifications';
import { removeTags } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const COLLAPSED_ROW_COUNT = 8;

type View = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; id: number };

export function BlurbManagerModal({ onInsert }: { onInsert?: (blurb: BlurbItem) => void }) {
  const dialog = useDialogContext();
  const mobile = !!useIsMobile({ type: 'media' });
  const [view, setView] = useState<View>({ kind: 'list' });

  const { data: blurbs = [], isLoading } = trpc.blurb.getMine.useQuery();
  const editing = view.kind === 'edit' ? blurbs.find((x) => x.id === view.id) : undefined;

  const body =
    view.kind === 'create' ? (
      <BlurbForm key="create" onCancel={() => setView({ kind: 'list' })} onClose={dialog.onClose} />
    ) : editing ? (
      <BlurbForm
        key={editing.id}
        blurb={editing}
        onCancel={() => setView({ kind: 'list' })}
        onClose={dialog.onClose}
      />
    ) : (
      <BlurbListView
        blurbs={blurbs}
        loading={isLoading}
        mobile={mobile}
        onClose={dialog.onClose}
        onCreate={() => setView({ kind: 'create' })}
        onEdit={(id) => setView({ kind: 'edit', id })}
        onInsert={
          onInsert
            ? (blurb) => {
                onInsert(blurb);
                dialog.onClose();
              }
            : undefined
        }
      />
    );

  if (mobile)
    return (
      <Drawer
        {...dialog}
        position="bottom"
        size="90%"
        padding={0}
        withCloseButton={false}
        classNames={{ content: 'rounded-t-md' }}
        styles={{
          content: { height: 'auto', maxHeight: '90dvh', overflowY: 'auto' },
          body: { padding: 0 },
        }}
      >
        <div className="flex justify-center py-2.5">
          <div className="h-1 w-9 rounded-sm bg-gray-4 dark:bg-dark-3"></div>
        </div>
        {body}
      </Drawer>
    );

  return (
    <Modal {...dialog} size={640} padding={0} withCloseButton={false}>
      {body}
    </Modal>
  );
}

export default BlurbManagerModal;

function BlurbListView({
  blurbs,
  loading,
  mobile,
  onClose,
  onCreate,
  onEdit,
  onInsert,
}: {
  blurbs: BlurbItem[];
  loading: boolean;
  mobile: boolean;
  onClose: () => void;
  onCreate: () => void;
  onEdit: (id: number) => void;
  onInsert?: (blurb: BlurbItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const atLimit = blurbs.length >= MAX_BLURBS_PER_USER;
  const hidden = expanded ? 0 : Math.max(0, blurbs.length - COLLAPSED_ROW_COUNT);
  const visible = hidden > 0 ? blurbs.slice(0, COLLAPSED_ROW_COUNT) : blurbs;

  return (
    <>
      <div className="border-0 border-b border-solid border-gray-3 px-5 py-[18px] dark:border-dark-4">
        <Group gap={10} wrap="nowrap">
          <IconRepeat size={20} stroke={1.5} className="text-blue-6" />
          <Text fz={24} fw={700} c="bright">
            Snippets
          </Text>
          <Badge variant="light" color={atLimit ? 'yellow' : 'gray'} radius="xl" size="sm">
            {blurbs.length} of {MAX_BLURBS_PER_USER}
          </Badge>
          <div className="flex-1" />
          {!mobile && <CloseButton onClick={onClose} />}
        </Group>
        <Text size="xs" c="dimmed" mt={4}>
          Reusable text you write once. Editing a snippet updates every model, article and post it
          appears in.
        </Text>
      </div>

      {atLimit && (
        <Alert color="yellow" radius={0} icon={<IconAlertTriangle size={15} stroke={1.5} />}>
          <Text size="xs">
            You are at the limit of {MAX_BLURBS_PER_USER} snippets. Delete one to make room for
            another.
          </Text>
        </Alert>
      )}

      {loading ? (
        <Group justify="center" p="xl">
          <Loader size="sm" />
        </Group>
      ) : blurbs.length === 0 ? (
        <Stack align="center" gap={12} className="px-10 py-11">
          <ThemeIcon size={52} radius="xl" variant="light" color="gray">
            <IconRepeat size={24} stroke={1.5} />
          </ThemeIcon>
          <Text fz={18} fw={700} c="bright">
            Nothing reusable yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={420}>
            Save the text you keep retyping — a support link, your licence terms, recommended
            settings. Change it here later and every model, article and post using it follows.
          </Text>
          <Button onClick={onCreate}>Create your first snippet</Button>
        </Stack>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          {visible.map((blurb) => (
            <BlurbRow
              key={blurb.id}
              blurb={blurb}
              mobile={mobile}
              onEdit={() => onEdit(blurb.id)}
              onInsert={onInsert ? () => onInsert(blurb) : undefined}
            />
          ))}
          {hidden > 0 && (
            <UnstyledButton className="w-full py-3" onClick={() => setExpanded(true)}>
              <Text size="xs" c="dimmed" ta="center">
                + {hidden} more
              </Text>
            </UnstyledButton>
          )}
        </div>
      )}

      <Group
        gap={12}
        wrap="nowrap"
        className={clsx(
          'border-0 border-t border-solid border-gray-3 dark:border-dark-4',
          mobile ? 'p-4' : 'px-5 py-3.5'
        )}
      >
        {!mobile && (
          <Group gap={6} wrap="nowrap" className="flex-1">
            <IconBulb size={14} stroke={1.5} className="text-gray-6 dark:text-dark-2" />
            <Text size="xs" c="dimmed">
              Type // in any editor to insert a snippet
            </Text>
          </Group>
        )}
        <Button
          variant={mobile ? 'filled' : 'subtle'}
          fullWidth={mobile}
          leftSection={mobile ? undefined : <IconPlus size={16} stroke={1.5} />}
          disabled={atLimit}
          onClick={onCreate}
        >
          New snippet
        </Button>
      </Group>
    </>
  );
}

function BlurbRow({
  blurb,
  mobile,
  onEdit,
  onInsert,
}: {
  blurb: BlurbItem;
  mobile: boolean;
  onEdit: () => void;
  onInsert?: () => void;
}) {
  const onDelete = useDeleteBlurb(blurb);

  return (
    <Group
      gap={mobile ? 10 : 12}
      wrap="nowrap"
      className={clsx(
        'border-0 border-b border-solid border-gray-3 dark:border-dark-4',
        mobile ? 'px-4 py-3' : 'p-3',
        mobile && onInsert && 'cursor-pointer'
      )}
      onClick={mobile ? onInsert : undefined}
    >
      <Stack gap={3} className="min-w-0 flex-1">
        <Text size="sm" fw={600} c="bright" lineClamp={1}>
          {blurb.name}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {blurbPreview(blurb.content)}
        </Text>
      </Stack>

      {mobile ? (
        <Menu withinPortal position="bottom-end">
          <Menu.Target>
            <ActionIcon onClick={(e: MouseEvent) => e.stopPropagation()}>
              <IconDotsVertical size={16} stroke={1.5} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            {onInsert && <Menu.Item onClick={onInsert}>Insert</Menu.Item>}
            <Menu.Item leftSection={<IconPencil size={14} stroke={1.5} />} onClick={onEdit}>
              Edit
            </Menu.Item>
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={onDelete}
            >
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      ) : (
        <Group gap={4} wrap="nowrap">
          {onInsert && (
            <Button size="compact-xs" onClick={onInsert}>
              Insert
            </Button>
          )}
          <ActionIcon aria-label={`Edit ${blurb.name}`} onClick={onEdit}>
            <IconPencil size={16} stroke={1.5} />
          </ActionIcon>
          <ActionIcon aria-label={`Delete ${blurb.name}`} onClick={onDelete}>
            <IconTrash size={16} stroke={1.5} />
          </ActionIcon>
        </Group>
      )}
    </Group>
  );
}

function BlurbForm({
  blurb,
  onCancel,
  onClose,
}: {
  blurb?: BlurbItem;
  onCancel: () => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [name, setName] = useState(blurb?.name ?? '');
  const [content, setContent] = useState(blurb?.content ?? '');
  const onDelete = useDeleteBlurb(blurb, onCancel);
  // The counter promises characters of TEXT, which is what a creator is writing; the cap the
  // server enforces is on the sanitized HTML, which is never shorter. Blocking on both keeps the
  // counter honest without letting markup smuggle a body past the cap.
  const textLength = removeTags(content).length;
  const overLimit = textLength > MAX_BLURB_LENGTH || content.length > MAX_BLURB_LENGTH;

  const createMutation = trpc.blurb.create.useMutation({
    onSuccess: async () => {
      await utils.blurb.getMine.invalidate();
      onCancel();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not create snippet', error: new Error(error.message) }),
  });

  const updateMutation = trpc.blurb.update.useMutation({
    onSuccess: async () => {
      await utils.blurb.getMine.invalidate();
      showNotification({
        icon: <IconRefresh size={18} />,
        color: 'blue',
        title: 'Snippet saved',
        message:
          'Everywhere it is used is being updated. They catch up within a few minutes — you do not need to stay on this page.',
        autoClose: 6000,
      });
      onCancel();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not save snippet', error: new Error(error.message) }),
  });

  const pending = createMutation.isPending || updateMutation.isPending;
  const canSubmit = !overLimit && !!removeTags(content) && (!!blurb || !!name.trim());

  const submit = () => {
    if (!canSubmit) return;
    if (blurb) updateMutation.mutate({ id: blurb.id, content });
    else createMutation.mutate({ name: name.trim(), content });
  };

  return (
    <>
      <Group
        gap={10}
        wrap="nowrap"
        className="border-0 border-b border-solid border-gray-3 px-5 py-[18px] dark:border-dark-4"
      >
        <ActionIcon aria-label="Back to snippets" onClick={onCancel}>
          <IconArrowLeft size={18} stroke={1.5} />
        </ActionIcon>
        <Text fz={20} fw={700} c="bright">
          {blurb ? 'Edit snippet' : 'New snippet'}
        </Text>
        <div className="flex-1" />
        <CloseButton onClick={onClose} />
      </Group>

      <Stack gap={22} p={20}>
        <Stack gap={6}>
          <Text size="sm" fw={600} c="bright">
            Name
          </Text>
          {!blurb && (
            <Text size="xs" c="dimmed">
              Only you see this. Pick something you will recognise in the list — it cannot be
              changed later.
            </Text>
          )}
          <TextInput
            aria-label="Name"
            value={blurb?.name ?? name}
            disabled={!!blurb}
            maxLength={60}
            rightSection={blurb ? <IconLock size={14} stroke={1.5} /> : undefined}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          {blurb && (
            <Text size="xs" c="dimmed">
              A snippet&apos;s name is fixed once it is created.
            </Text>
          )}
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={600} c="bright">
            Text
          </Text>
          <RichTextEditor
            value={content}
            onChange={setContent}
            includeControls={['heading', 'formatting', 'colors', 'list', 'link']}
            // Blockquote and code block are the two the stored allowlist omits — see
            // BLURB_INTERIOR_ALLOWED_TAGS.
            withoutBlockContainers
            withLinkValidation
            editorSize="md"
          />
          <Text size="xs" c={overLimit ? 'red' : 'dimmed'}>
            {textLength.toLocaleString('en-US')} / {MAX_BLURB_LENGTH.toLocaleString('en-US')}{' '}
            characters
          </Text>
        </Stack>

        {blurb && (
          <div className="rounded-sm border-0 border-l-[3px] border-solid border-blue-6 bg-blue-1 p-3.5 dark:bg-blue-8/20">
            <Group gap={8} wrap="nowrap">
              <IconRefresh size={15} stroke={1.5} className="text-blue-4" />
              <Text size="sm" fw={600} c="bright">
                This edit is not local
              </Text>
            </Group>
            <Text size="xs" c="dimmed" mt={8}>
              Saving rewrites every model, article and post using this snippet. They update on their
              own within a few minutes; each one is re-scanned like any edit you make by hand.
            </Text>
          </div>
        )}
      </Stack>

      <Group
        gap={10}
        wrap="nowrap"
        className="border-0 border-t border-solid border-gray-3 px-5 py-3.5 dark:border-dark-4"
      >
        {blurb && (
          <Button
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={15} stroke={1.5} />}
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!canSubmit} loading={pending} onClick={submit}>
          {blurb ? 'Save changes' : 'Create snippet'}
        </Button>
      </Group>
    </>
  );
}

// The same confirm the other entities use (see the model page) rather than a bespoke modal, so
// a destructive action reads the same way wherever a creator meets one.
function useDeleteBlurb(blurb: BlurbItem | undefined, onDeleted?: () => void) {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.blurb.delete.useMutation({
    onSuccess: async () => {
      await utils.blurb.getMine.invalidate();
      closeAllModals();
      onDeleted?.();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not delete snippet', error: new Error(error.message) }),
  });

  return () =>
    blurb &&
    openConfirmModal({
      title: 'Delete Snippet',
      children: `Are you sure you want to delete "${blurb.name}"? Anywhere it is used keeps the words exactly as they are — they just become ordinary text and stop updating. This cannot be reverted.`,
      centered: true,
      labels: { confirm: 'Delete Snippet', cancel: "No, don't delete it" },
      confirmProps: { color: 'red', disabled: deleteMutation.isPending },
      closeOnConfirm: false,
      onConfirm: () => deleteMutation.mutate({ id: blurb.id }),
    });
}
