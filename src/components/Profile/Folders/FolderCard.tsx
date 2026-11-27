import { ActionIcon, Button, Loader, Text } from '@mantine/core';
import {
  IconChevronLeft,
  IconChevronRight,
  IconDotsVertical,
  IconEye,
  IconEyeOff,
  IconFolder,
  IconLock,
  IconPencil,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ImageCard } from '~/components/Cards/ImageCard';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { Menu } from '~/components/MantineOverlays';
import { NextLink } from '~/components/NextLink/NextLink';
import type { FolderItem } from '~/components/Profile/Folders/folder.utils';
import {
  folderItemKey,
  folderUrl,
  useFolderItems,
} from '~/components/Profile/Folders/folder.utils';
import type { ProfileFolder } from '~/server/services/profile-folders.service';
import { CollectionReadConfiguration } from '~/shared/utils/prisma/enums';
import { FolderThumb } from '~/components/Profile/Folders/FolderThumb';

export type FolderCardActions = {
  onEdit: (folder: ProfileFolder) => void;
  onToggleHidden: (folder: ProfileFolder) => void;
  onDelete: (folder: ProfileFolder) => void;
};

export function FolderCard({
  folder,
  user,
  isOwner,
  actions,
}: {
  folder: ProfileFolder;
  user: { id: number; username: string };
  isOwner: boolean;
  actions?: FolderCardActions;
}) {
  const [ref, inView] = useInViewDynamic({ id: `profile-folder-${folder.id}` });
  const { items, isLoading } = useFolderItems(folder.preview, {
    userId: user.id,
    username: user.username,
    enabled: inView,
  });
  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, items.length - 1)];
  const step = (by: number) => setIndex((i) => (i + by + items.length) % items.length);
  const href = folderUrl(user.username, folder.id);

  return (
    <div
      ref={ref}
      data-profile-card
      className={clsx(
        'flex w-[320px] shrink-0 snap-start flex-col overflow-visible rounded-lg border border-gray-3 dark:border-dark-4',
        folder.hidden && 'opacity-60'
      )}
      style={{
        background: 'var(--profile-card-bg, var(--mantine-color-body))',
        backdropFilter: 'var(--profile-card-blur, none)',
      }}
    >
      <div className="flex items-start gap-2 p-4 pb-3">
        <div className="min-w-0 flex-1">
          <NextLink href={href} className="block">
            <Text fw={700} size="lg" lineClamp={1} c="var(--mantine-color-bright)">
              {folder.name}
            </Text>
          </NextLink>
          {folder.description && (
            <Text size="sm" c="dimmed" lineClamp={2}>
              {folder.description}
            </Text>
          )}
          {isOwner && (folder.read !== CollectionReadConfiguration.Public || folder.hidden) && (
            <Text size="xs" c="dimmed" className="mt-1 flex items-center gap-1">
              {folder.hidden ? <IconEyeOff size={12} /> : <IconLock size={12} />}
              {folder.hidden ? 'Off your profile' : folder.read}
            </Text>
          )}
        </div>
        {isOwner && actions && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" radius="xl" aria-label="Folder options">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<IconPencil size={14} />}
                onClick={() => actions.onEdit(folder)}
              >
                Edit folder
              </Menu.Item>
              <Menu.Item
                leftSection={folder.hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                onClick={() => actions.onToggleHidden(folder)}
              >
                {folder.hidden ? 'Show on profile' : 'Hide from profile'}
              </Menu.Item>
              <Menu.Item
                color="red"
                leftSection={<IconTrash size={14} />}
                onClick={() => actions.onDelete(folder)}
              >
                Delete folder
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </div>

      <div className="relative px-4">
        {folder.counts.total === 0 ? (
          <EmptyPreview
            isOwner={isOwner}
            onAdd={actions ? () => actions.onEdit(folder) : undefined}
          />
        ) : !current ? (
          <div className="flex aspect-[7/9] items-center justify-center rounded-md bg-gray-2 dark:bg-dark-5">
            {isLoading || !inView ? (
              <Loader size="sm" />
            ) : (
              <NextLink href={href} className="flex flex-col items-center gap-1 text-center">
                <IconFolder size={32} className="text-gray-5" />
                <Text size="sm" c="dimmed">
                  Open the folder
                </Text>
              </NextLink>
            )}
          </div>
        ) : (
          <>
            <PreviewCard item={current} />
            <span className="pointer-events-none absolute right-6 top-2 z-20 rounded bg-black/70 px-1.5 text-[11px] font-bold text-white">
              {Math.min(index, items.length - 1) + 1} / {items.length}
            </span>
            {items.length > 1 && (
              <>
                <ActionIcon
                  className="absolute left-1 top-1/2 z-20 -translate-y-1/2"
                  radius="xl"
                  size="lg"
                  variant="filled"
                  color="dark"
                  aria-label="Previous item"
                  onClick={() => step(-1)}
                >
                  <IconChevronLeft size={18} />
                </ActionIcon>
                <ActionIcon
                  className="absolute right-1 top-1/2 z-20 -translate-y-1/2"
                  radius="xl"
                  size="lg"
                  variant="filled"
                  color="dark"
                  aria-label="Next item"
                  onClick={() => step(1)}
                >
                  <IconChevronRight size={18} />
                </ActionIcon>
              </>
            )}
          </>
        )}
      </div>

      <div className="mt-auto px-4 pb-4 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <Text size="10px" fw={700} tt="uppercase" c="dimmed" className="tracking-wider">
            {folder.counts.total} {folder.counts.total === 1 ? 'item' : 'items'}
          </Text>
          <Button
            component={NextLink}
            href={href}
            variant="subtle"
            size="compact-xs"
            rightSection={<IconChevronRight size={12} />}
          >
            Open
          </Button>
        </div>
        {items.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {items.map((item, i) => (
              <button
                key={folderItemKey(item)}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show item ${i + 1}`}
                aria-current={i === index}
                className={clsx(
                  'relative size-11 shrink-0 overflow-hidden rounded border-2',
                  i === index ? 'border-blue-5' : 'border-transparent opacity-70 hover:opacity-100'
                )}
              >
                <FolderThumb item={item} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewCard({ item }: { item: FolderItem }) {
  if (item.type === 'Image')
    return (
      <ImagesProvider images={[item.data]}>
        <ImageCard data={item.data} hideCreator />
      </ImagesProvider>
    );
  if (item.type === 'Model') return <ModelCard data={item.data} />;
  return <ArticleCard data={item.data} aspectRatio="portrait" />;
}

function EmptyPreview({ isOwner, onAdd }: { isOwner: boolean; onAdd?: () => void }) {
  return (
    <div className="flex aspect-[7/9] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-gray-4 p-4 text-center dark:border-dark-3">
      <IconFolder size={32} className="text-gray-5" />
      <Text size="sm" c="dimmed">
        {isOwner ? 'Nothing in this folder yet.' : 'This folder is empty.'}
      </Text>
      {isOwner && onAdd && (
        <Button
          size="compact-sm"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={onAdd}
        >
          Add items
        </Button>
      )}
    </div>
  );
}
