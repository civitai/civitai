import {
  ActionIcon,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { IconGripVertical, IconPlus, IconX } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import type { FolderRowSchema } from '~/server/schema/profile-folders.schema';
import { profileFolderLimits } from '~/server/schema/profile-folders.schema';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type ManageFoldersModalProps = { userId: number };

type Entry =
  | { kind: 'row'; key: string; id: string; name: string }
  | { kind: 'folder'; key: string; id: number; name: string; total: number; hidden: boolean };

const newRowId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Create folders and arrange them: drag to order, switch a folder off to keep it off the profile,
 * and add named rows. A folder sits in the row whose name is above it; folders above the first
 * name form an untitled row at the top.
 */
export default function ManageFoldersModal({ userId }: ManageFoldersModalProps) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.profileFolders.getAll.useQuery({ userId });
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (!data || entries !== null) return;
    setEntries(
      data.rows.flatMap((row, i): Entry[] => [
        // The first untitled row is the list's top; a later one is a named row left blank.
        ...(i === 0 && !row.name
          ? []
          : [
              {
                kind: 'row' as const,
                key: `row-${row.id ?? i}`,
                id: row.id ?? newRowId(),
                name: row.name,
              },
            ]),
        ...row.folders.map((folder) => ({
          kind: 'folder' as const,
          key: `folder-${folder.id}`,
          id: folder.id,
          name: folder.name,
          total: folder.counts.total,
          hidden: folder.hidden,
        })),
      ])
    );
  }, [data, entries]);

  const create = trpc.profileFolders.create.useMutation({
    onSuccess: (folder) => {
      setNewName('');
      void utils.profileFolders.getAll.invalidate({ userId });
      setEntries((current) => [
        ...(current ?? []),
        {
          kind: 'folder',
          key: `folder-${folder.id}`,
          id: folder.id,
          name: folder.name,
          total: 0,
          hidden: false,
        },
      ]);
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not create the folder',
        error: new Error(error.message),
      }),
  });
  const setRows = trpc.profileFolders.setRows.useMutation({
    onSuccess: async () => {
      await utils.profileFolders.getAll.invalidate({ userId });
      dialog.onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not save your folders',
        error: new Error(error.message),
      }),
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setEntries((current) => {
      if (!current) return current;
      const from = current.findIndex((entry) => entry.key === active.id);
      const to = current.findIndex((entry) => entry.key === over.id);
      return arrayMove(current, from, to);
    });
  };
  const update = (key: string, change: Partial<Entry>) =>
    setEntries((current) =>
      (current ?? []).map((entry) =>
        entry.key === key ? ({ ...entry, ...change } as Entry) : entry
      )
    );

  const rowCount = (entries ?? []).filter((entry) => entry.kind === 'row').length;
  const toRows = (list: Entry[]): FolderRowSchema[] => {
    const rows: FolderRowSchema[] = [{ id: 'top', name: '', folders: [] }];
    for (const entry of list) {
      if (entry.kind === 'row') rows.push({ id: entry.id, name: entry.name.trim(), folders: [] });
      else
        rows[rows.length - 1].folders.push({
          id: entry.id,
          ...(entry.hidden ? { hidden: true } : {}),
        });
    }
    return rows.filter((row, i) => i > 0 || row.folders.length);
  };
  const overfull = toRows(entries ?? []).find(
    (row) => row.folders.length > profileFolderLimits.foldersPerRow
  );

  const save = () => {
    if (!entries) return;
    setRows.mutate({
      rows: toRows(entries),
      ...(data?.storedRows ? { ifUnchangedFrom: data.storedRows } : {}),
    });
  };

  return (
    <Modal {...dialog} title="Manage folders" size="lg">
      <Stack gap="lg">
        <Stack gap={6}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            New folder
          </Text>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              className="flex-1"
              placeholder="Folder name"
              value={newName}
              maxLength={profileFolderLimits.name}
              onChange={(event) => setNewName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && newName.trim())
                  create.mutate({ name: newName.trim() });
              }}
            />
            <Button
              onClick={() => create.mutate({ name: newName.trim() })}
              disabled={!newName.trim()}
              loading={create.isPending}
            >
              Create folder
            </Button>
          </Group>
          <Text size="xs" c="dimmed">
            A folder can hold your images, videos, models and articles together.
          </Text>
        </Stack>

        <Stack gap={6}>
          <Text size="xs" fw={700} tt="uppercase" c="dimmed">
            Arrange folders
          </Text>
          <Text size="xs" c="dimmed">
            Drag folders into the order you want, and switch off any you want to keep off your
            profile. Rows group folders on your Folders page: a folder sits in the row whose name is
            above it.
          </Text>
          {isLoading || entries === null ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : entries.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              You have no folders yet. Create one above.
            </Text>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext
                items={entries.map((entry) => entry.key)}
                strategy={verticalListSortingStrategy}
              >
                <Stack gap={6}>
                  {entries.map((entry) => (
                    <SortableItem key={entry.key} id={entry.key} cursor="grab">
                      {entry.kind === 'row' ? (
                        <Paper radius="md" p={6} className="bg-blue-0 dark:bg-dark-5">
                          <Group gap="xs" wrap="nowrap">
                            <IconGripVertical size={16} className="shrink-0 text-gray-6" />
                            <TextInput
                              className="flex-1"
                              size="xs"
                              placeholder="Row name"
                              aria-label="Row name"
                              value={entry.name}
                              maxLength={profileFolderLimits.rowName}
                              onChange={(event) =>
                                update(entry.key, { name: event.currentTarget.value })
                              }
                            />
                            <ActionIcon
                              variant="subtle"
                              color="gray"
                              aria-label="Remove row"
                              onClick={() =>
                                setEntries((current) =>
                                  (current ?? []).filter((other) => other.key !== entry.key)
                                )
                              }
                            >
                              <IconX size={14} />
                            </ActionIcon>
                          </Group>
                        </Paper>
                      ) : (
                        <Paper withBorder radius="md" p="xs">
                          <Group gap="xs" wrap="nowrap">
                            <IconGripVertical size={16} className="shrink-0 text-gray-6" />
                            <Text size="sm" fw={600} lineClamp={1} className="min-w-0 flex-1">
                              {entry.name}{' '}
                              <Text span size="xs" c="dimmed" fw={400}>
                                {entry.total} {entry.total === 1 ? 'item' : 'items'}
                              </Text>
                            </Text>
                            <Switch
                              checked={!entry.hidden}
                              aria-label={`Show ${entry.name} on your profile`}
                              onChange={(event) =>
                                update(entry.key, { hidden: !event.currentTarget.checked })
                              }
                            />
                          </Group>
                        </Paper>
                      )}
                    </SortableItem>
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          )}
          <Button
            variant="light"
            leftSection={<IconPlus size={14} />}
            disabled={entries === null || rowCount >= profileFolderLimits.rows - 1}
            onClick={() =>
              setEntries((current) => {
                const id = newRowId();
                return [...(current ?? []), { kind: 'row', key: `row-${id}`, id, name: 'New row' }];
              })
            }
          >
            Add a row
          </Button>
          {overfull && (
            <Text size="xs" c="red">
              A row holds up to {profileFolderLimits.foldersPerRow} folders
              {overfull.name ? ` ("${overfull.name}" has ${overfull.folders.length})` : ''}. Add a
              row to split it.
            </Text>
          )}
        </Stack>

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={setRows.isPending} disabled={!entries || !!overfull}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
