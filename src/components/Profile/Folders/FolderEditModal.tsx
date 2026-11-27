import {
  ActionIcon,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconStar, IconStarFilled, IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Tooltip } from '~/components/MantineOverlays';
import type { FolderItem } from '~/components/Profile/Folders/folder.utils';
import {
  folderItemCover,
  folderItemKey,
  useFolderItems,
} from '~/components/Profile/Folders/folder.utils';
import { FolderThumb } from '~/components/Profile/Folders/FolderThumb';
import { ShowcaseOwnItemsPicker } from '~/components/Profile/ShowcaseOwnItemsPicker';
import { BULK_SAVE_MAX_ITEMS } from '~/server/schema/collection.schema';
import { profileFolderLimits } from '~/server/schema/profile-folders.schema';
import type { FolderItemRef } from '~/server/services/profile-folder-reads.service';
import { CollectionReadConfiguration, CollectionType } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type FolderEditModalProps = {
  folder: {
    id: number;
    name: string;
    description: string | null;
    read: CollectionReadConfiguration;
  };
  user: { id: number; username: string };
};

type StagedItem = FolderItemRef & { collectionItemId?: number; showcased: boolean };

const privacyOptions = [
  { value: CollectionReadConfiguration.Public, label: 'Public: on your profile' },
  { value: CollectionReadConfiguration.Unlisted, label: 'Unlisted: only people with the link' },
  { value: CollectionReadConfiguration.Private, label: 'Private: only you' },
];

const PAGE = 48;

const chunk = <T,>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, i * size + size)
  );

/**
 * Edit a folder: its name, description and privacy, what is in it, and which items its card
 * shows. Everything is staged and saved together.
 */
export default function FolderEditModal({ folder, user }: FolderEditModalProps) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description ?? '');
  const [read, setRead] = useState(folder.read);
  const [staged, setStaged] = useState<StagedItem[] | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [saving, setSaving] = useState(false);

  const { data: stored, isLoading } = trpc.profileFolders.getItems.useQuery({
    folderId: folder.id,
  });
  useEffect(() => {
    if (stored && staged === null) setStaged(stored);
  }, [stored, staged]);

  const items = useMemo(() => staged ?? [], [staged]);
  const visibleRefs = useMemo(() => items.slice(0, shown), [items, shown]);
  const hydrated = useFolderItems(visibleRefs, { userId: user.id, username: user.username });
  const hydratedByKey = new Map(hydrated.items.map((item) => [folderItemKey(item), item]));
  const showcasedCount = items.filter((item) => item.showcased).length;

  const upsert = trpc.collection.upsert.useMutation();
  const bulkSave = trpc.collection.bulkSaveItems.useMutation();
  const remove = trpc.collection.removeFromCollection.useMutation();
  const setShowcase = trpc.profileFolders.setItemShowcase.useMutation();

  const toggleItem = (entry: { entityType: string; entityId: number }) =>
    setStaged((current) => {
      const list = current ?? [];
      const at = list.findIndex(
        (item) => item.type === entry.entityType && item.id === entry.entityId
      );
      if (at > -1) return list.filter((_, i) => i !== at);
      return [
        { type: entry.entityType as FolderItemRef['type'], id: entry.entityId, showcased: false },
        ...list,
      ];
    });
  const toggleShowcase = (target: StagedItem) =>
    setStaged((current) =>
      (current ?? []).map((item) =>
        item === target ? { ...item, showcased: !item.showcased } : item
      )
    );

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const before = stored ?? [];
      const key = (item: FolderItemRef) => `${item.type}-${item.id}`;
      const now = new Set(items.map(key));
      const was = new Set(before.map(key));
      const removed = before.filter((item) => !now.has(key(item)));
      const added = items.filter((item) => !was.has(key(item)));

      if (
        name.trim() !== folder.name ||
        description.trim() !== (folder.description ?? '') ||
        read !== folder.read
      )
        await upsert.mutateAsync({
          id: folder.id,
          name: name.trim(),
          description: description.trim() || null,
          read,
        });

      for (const type of ['Image', 'Model', 'Article'] as const) {
        const ids = removed.filter((item) => item.type === type).map((item) => item.id);
        for (const itemIds of chunk(ids, 100))
          await remove.mutateAsync({
            collectionId: folder.id,
            itemIds,
            type: CollectionType[type],
          });
      }
      const addedIds = (type: FolderItemRef['type']) =>
        added.filter((item) => item.type === type).map((item) => item.id);
      const [imageIds, modelIds, articleIds] = [
        addedIds('Image'),
        addedIds('Model'),
        addedIds('Article'),
      ];
      const rounds = Math.ceil(
        Math.max(imageIds.length, modelIds.length, articleIds.length) / BULK_SAVE_MAX_ITEMS
      );
      for (let i = 0; i < rounds; i++) {
        const slice = (ids: number[]) =>
          ids.slice(i * BULK_SAVE_MAX_ITEMS, (i + 1) * BULK_SAVE_MAX_ITEMS);
        await bulkSave.mutateAsync({
          collectionId: folder.id,
          imageIds: slice(imageIds),
          modelIds: slice(modelIds),
          articleIds: slice(articleIds),
        });
      }

      // Off before on, so a swap never needs a ninth slot.
      const storedById = new Map(before.map((item) => [item.collectionItemId, item]));
      const changed = items.filter(
        (item) =>
          item.collectionItemId != null &&
          storedById.get(item.collectionItemId)?.showcased !== item.showcased
      );
      for (const item of [...changed].sort((a, b) => Number(a.showcased) - Number(b.showcased)))
        await setShowcase.mutateAsync({
          collectionItemId: item.collectionItemId as number,
          showcased: item.showcased,
        });

      await Promise.all([
        utils.profileFolders.getAll.invalidate({ userId: user.id }),
        utils.profileFolders.get.invalidate({ folderId: folder.id }),
        utils.profileFolders.getItems.invalidate({ folderId: folder.id }),
      ]);
      showSuccessNotification({ message: 'Folder saved' });
      dialog.onClose();
    } catch (error) {
      showErrorNotification({ title: 'Could not save the folder', error: error as Error });
      // Show what did save, so a retry does not repeat it.
      await utils.profileFolders.getItems.invalidate({ folderId: folder.id });
      setStaged(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal {...dialog} title="Edit folder" size="xl">
      <Stack gap="md">
        <TextInput
          label="Name"
          required
          value={name}
          maxLength={profileFolderLimits.name}
          onChange={(event) => setName(event.currentTarget.value)}
          error={!name.trim() ? 'Give the folder a name' : undefined}
        />
        <Textarea
          label="Description"
          value={description}
          maxLength={profileFolderLimits.description}
          autosize
          minRows={2}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
        <Select
          label="Privacy"
          data={privacyOptions}
          value={read}
          allowDeselect={false}
          onChange={(value) => value && setRead(value as CollectionReadConfiguration)}
        />

        <Stack gap={6}>
          <Group justify="space-between">
            <Text size="sm" fw={600}>
              In this folder ({items.length})
            </Text>
            <Text size="xs" c="dimmed">
              <IconStar size={12} className="inline align-[-2px]" /> picks what the folder card
              shows ({showcasedCount}/{profileFolderLimits.showcase})
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Removing an item only takes it out of this folder; nothing is deleted from your account.
          </Text>
          {isLoading || staged === null ? (
            <Center py="md">
              <Loader size="sm" />
            </Center>
          ) : items.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              Nothing here yet. Add your work below.
            </Text>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
                {visibleRefs.map((item) => (
                  <StagedTile
                    key={folderItemKey(item)}
                    item={item}
                    hydrated={hydratedByKey.get(folderItemKey(item))}
                    loading={hydrated.isLoading}
                    showcaseFull={showcasedCount >= profileFolderLimits.showcase}
                    onRemove={() => toggleItem({ entityType: item.type, entityId: item.id })}
                    onToggleShowcase={() => toggleShowcase(item)}
                  />
                ))}
              </div>
              {items.length > shown && (
                <Button
                  variant="subtle"
                  size="compact-sm"
                  className="self-center"
                  onClick={() => setShown((n) => n + PAGE)}
                >
                  Show more ({items.length - shown})
                </Button>
              )}
            </>
          )}
        </Stack>

        <Stack gap={6}>
          <Text size="sm" fw={600}>
            Add from your work
          </Text>
          <ShowcaseOwnItemsPicker
            userId={user.id}
            username={user.username}
            kinds={['Image', 'Model', 'Article']}
            selected={items.map((item) => ({ entityType: item.type, entityId: item.id }))}
            limit={profileFolderLimits.editorItems}
            fullMessage={`The editor holds up to ${profileFolderLimits.editorItems} items.`}
            onToggle={toggleItem}
          />
        </Stack>

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!name.trim() || staged === null}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function StagedTile({
  item,
  hydrated,
  loading,
  showcaseFull,
  onRemove,
  onToggleShowcase,
}: {
  item: StagedItem;
  hydrated?: FolderItem;
  loading: boolean;
  showcaseFull: boolean;
  onRemove: () => void;
  onToggleShowcase: () => void;
}) {
  const saved = item.collectionItemId != null;
  const canShowcase = saved && (item.showcased || !showcaseFull);
  const label = hydrated
    ? hydrated.type === 'Model'
      ? hydrated.data.name
      : hydrated.type === 'Article'
      ? hydrated.data.title
      : `Image ${item.id}`
    : `${item.type} ${item.id}`;
  return (
    <div
      className={clsx(
        'relative aspect-square overflow-hidden rounded-md border-2 bg-gray-2 dark:bg-dark-5',
        item.showcased ? 'border-yellow-5' : 'border-transparent'
      )}
      title={label}
    >
      {hydrated && folderItemCover(hydrated) ? (
        <FolderThumb item={hydrated} />
      ) : (
        <Center className="size-full">
          {loading ? (
            <Loader size="xs" />
          ) : (
            <Text size="10px" c="dimmed" ta="center" px={4}>
              {item.type}
            </Text>
          )}
        </Center>
      )}
      <ActionIcon
        className="absolute left-1 top-1"
        size="sm"
        radius="xl"
        color="red"
        variant="filled"
        aria-label={`Remove ${label} from this folder`}
        onClick={onRemove}
      >
        <IconTrash size={12} />
      </ActionIcon>
      <Tooltip
        label={
          !saved
            ? 'Save the folder first'
            : item.showcased
            ? 'Shown on the folder card'
            : canShowcase
            ? 'Show on the folder card'
            : `The card shows up to ${profileFolderLimits.showcase}`
        }
      >
        <ActionIcon
          className="absolute right-1 top-1"
          size="sm"
          radius="xl"
          color={item.showcased ? 'yellow' : 'dark'}
          variant="filled"
          aria-label={
            item.showcased ? `Stop showing ${label} on the card` : `Show ${label} on the card`
          }
          aria-pressed={item.showcased}
          disabled={!canShowcase}
          onClick={onToggleShowcase}
        >
          {item.showcased ? <IconStarFilled size={12} /> : <IconStar size={12} />}
        </ActionIcon>
      </Tooltip>
    </div>
  );
}
