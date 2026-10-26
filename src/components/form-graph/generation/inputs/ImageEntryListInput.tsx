import { Badge, Group, Input, Stack, Text } from '@mantine/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { useRef, type ReactNode } from 'react';
import { RecentImagesButton } from '~/components/Generation/Input/RecentImagesPicker';
import { SourceImageUploadMultiple } from '~/components/Generation/Input/SourceImageUploadMultiple';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import type { ImageObjectValue } from '~/shared/generation/values';
import {
  sourceImageKey,
  useRecentSourceImagesStore,
  type RecentSourceImage,
} from '~/store/recent-source-images.store';

export type ImageEntry = { image?: ImageObjectValue };

export interface ImageEntryListInputProps<T extends ImageEntry> {
  value?: T[] | null;
  /** `live` marks a control still being dragged: the value is provisional until it settles. */
  onChange?: (value: T[], options?: { live?: boolean }) => void;
  limit: number;
  label: string;
  description: string;
  error?: string;
  warnOnMissingAiMetadata?: boolean;
  makeEntry: (image: ImageObjectValue, entries: T[]) => T;
  renderControl: (
    entry: T,
    index: number,
    update: (patch: Partial<T>, options?: { live?: boolean }) => void
  ) => ReactNode;
  reorder?: (entries: T[], from: number, to: number) => T[];
}

/** Entries keep their settings across re-orders and removals by matching on image URL. */
export function ImageEntryListInput<T extends ImageEntry>({
  value,
  onChange,
  limit,
  label,
  description,
  error,
  warnOnMissingAiMetadata,
  makeEntry,
  renderControl,
  reorder = arrayMove,
}: ImageEntryListInputProps<T>) {
  const entries = value ?? [];

  const uploaderValue: SourceImageProps[] = entries
    .filter((e): e is T & { image: ImageObjectValue } => !!e.image?.url)
    .map((e) => ({ url: e.image.url, width: e.image.width ?? 0, height: e.image.height ?? 0 }));

  function handleImagesChange(images: SourceImageProps[] | null | undefined) {
    const byUrl = new Map<string, T>();
    for (const e of entries) {
      if (e.image?.url) byUrl.set(e.image.url, e);
    }
    const next: T[] = [];
    for (const img of images ?? []) {
      const image = { url: img.url, width: img.width, height: img.height };
      const kept = byUrl.get(img.url);
      next.push(kept ? { ...kept, image } : makeEntry(image, next));
    }
    onChange?.(next);
  }

  function updateEntry(index: number, patch: Partial<T>, options?: { live?: boolean }) {
    onChange?.(
      entries.map((e, i) => (i === index ? { ...e, ...patch } : e)),
      options
    );
  }

  const remaining = limit - uploaderValue.length;
  const hasRecent = useRecentSourceImagesStore((state) => state.images.length > 0);
  const showRecent = hasRecent && remaining > 0;

  // The picker is opened from a snapshot of props, so read the entries at pick time — an upload
  // that lands while it is open must not be overwritten.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  function handleSelectRecent(images: RecentSourceImage[]) {
    const current = entriesRef.current;
    const existing = new Set(
      current.flatMap((e) => (e.image?.url ? [sourceImageKey(e.image.url)] : []))
    );
    const next = [...current];
    for (const image of images) {
      if (next.length >= limit || existing.has(sourceImageKey(image.url))) continue;
      next.push(makeEntry({ url: image.url, width: image.width, height: image.height }, next));
    }
    if (next.length > current.length) onChange?.(next);
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = entries.findIndex((e) => e.image?.url === active.id);
    const to = entries.findIndex((e) => e.image?.url === over.id);
    if (from < 0 || to < 0) return;
    onChange?.(reorder(entries, from, to));
  }

  return (
    <Input.Wrapper
      label={
        <Group justify="space-between" className="w-full">
          <Group gap={6}>
            <Text component="span" fz="sm" fw={500}>
              {label}
            </Text>
            <Badge size="sm" variant="light" color="gray">
              {entries.length}/{limit}
            </Badge>
          </Group>
          <Group gap={12}>
            {showRecent && (
              <RecentImagesButton
                remaining={remaining}
                existingUrls={uploaderValue.map((image) => image.url)}
                onSelect={handleSelectRecent}
              />
            )}
            {entries.length > 1 && (
              <Text
                component="button"
                type="button"
                size="xs"
                c="red"
                className="cursor-pointer border-0 bg-transparent p-0"
                onClick={() => onChange?.([])}
              >
                Clear all
              </Text>
            )}
          </Group>
        </Group>
      }
      description={description}
      error={error}
      classNames={{ label: 'w-full' }}
    >
      <SourceImageUploadMultiple
        value={uploaderValue}
        onChange={handleImagesChange}
        max={limit}
        warnOnMissingAiMetadata={warnOnMissingAiMetadata}
      >
        {(previewItems) => (
          <Stack gap="sm" mt={6}>
            {previewItems.length > 0 && (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={uploaderValue.map((image) => image.url)}
                  strategy={verticalListSortingStrategy}
                >
                  <Stack gap="xs">
                    {previewItems.map((item, index) => {
                      // An upload in flight has no entry yet: it renders as a row with no control,
                      // not an invisible item holding a slot.
                      const entryIndex = entries.findIndex((e) => e.image?.url === item.url);
                      const entry = entries[entryIndex];
                      return (
                        <SortableRow
                          key={item.id ?? item.url}
                          id={item.url}
                          disabled={!entry}
                          handle={
                            <SourceImageUploadMultiple.Image
                              index={index}
                              {...item}
                              className="w-16 shrink-0"
                              showDimensions={false}
                              fit="cover"
                            />
                          }
                        >
                          {entry &&
                            renderControl(entry, entryIndex, (patch, options) =>
                              updateEntry(entryIndex, patch, options)
                            )}
                        </SortableRow>
                      );
                    })}
                  </Stack>
                </SortableContext>
              </DndContext>
            )}
            <SourceImageUploadMultiple.Dropzone className="h-24" />
          </Stack>
        )}
      </SourceImageUploadMultiple>
    </Input.Wrapper>
  );
}

function SortableRow({
  id,
  disabled,
  handle,
  children,
}: {
  id: string;
  disabled: boolean;
  handle: ReactNode;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });
  return (
    <Group
      ref={setNodeRef}
      gap="sm"
      wrap="nowrap"
      align="center"
      className={clsx(isDragging && 'relative z-10 opacity-80')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* `touch-none` keeps a touch drag from scrolling the page instead of moving the row. */}
      <div
        ref={setActivatorNodeRef}
        className={clsx('shrink-0 touch-none', !disabled && 'cursor-grab')}
        {...attributes}
        {...listeners}
      >
        {handle}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Group>
  );
}
