import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { IconEye, IconEyeOff, IconPhotoStar, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import {
  VERSION_SHOWCASE_LIMIT,
  type VersionShowcaseSite,
} from '~/shared/constants/version-showcase.constants';
import { isComSafeLevel } from '~/shared/utils/model-sfw-face';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { buildShowcaseItems, parseImageId, siteLabel, type Item } from './version-showcase.utils';

export default function VersionShowcaseEditor({
  modelVersionId,
  addImageId,
}: {
  modelVersionId: number;
  /** Opened from "Feature in showcase": this image is added to the list. */
  addImageId?: number;
}) {
  const dialog = useDialogContext();
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.versionShowcase.getEditor.useQuery({ modelVersionId });
  const [site, setSite] = useState<VersionShowcaseSite>('red');
  const [items, setItems] = useState<Item[]>([]);
  const [link, setLink] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    if (!data) return;
    const next = buildShowcaseItems(data, site);
    if (addImageId && !next.some((item) => item.imageId === addImageId))
      next.push({ imageId: addImageId, source: 'Community', excluded: false });
    setItems(next);
  }, [data, site, addImageId]);

  const save = trpc.versionShowcase.set.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `${siteLabel[site]} showcase saved` });
      await Promise.all([
        utils.versionShowcase.getEditor.invalidate({ modelVersionId }),
        utils.image.getInfinite.invalidate(),
      ]);
    },
    onError: (error) => showErrorNotification({ title: 'Could not save', error }),
  });
  const setCover = trpc.versionShowcase.setCover.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `${siteLabel[site]} cover updated` });
      await utils.versionShowcase.getEditor.invalidate({ modelVersionId });
    },
    onError: (error) => showErrorNotification({ title: 'Could not set the cover', error }),
  });

  const cover = data?.covers[site] ?? null;
  const communityCount = items.filter((item) => item.source === 'Community').length;
  const removedByAuthors = useMemo(
    () => new Set(data?.removedByAuthors.filter((row) => row.site === site).map((r) => r.imageId)),
    [data, site]
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setItems((current) => {
      const from = current.findIndex((item) => item.imageId === active.id);
      const to = current.findIndex((item) => item.imageId === over.id);
      return arrayMove(current, from, to);
    });
  };

  const addFromLink = () => {
    const imageId = parseImageId(link);
    if (!imageId) return showErrorNotification({ error: new Error('Paste an image link or id') });
    if (items.some((item) => item.imageId === imageId)) return setLink('');
    setItems((current) => [...current, { imageId, source: 'Community', excluded: false }]);
    setLink('');
  };

  // Only the creator's own images can be the .com cover of a mature model.
  const canBeCover = (item: Item) =>
    !!data?.isLatestPublished &&
    !item.excluded &&
    !(site === 'com' && data.isMature && item.source === 'Community') &&
    (site !== 'com' || item.nsfwLevel === undefined || isComSafeLevel(item.nsfwLevel));

  return (
    <Modal {...dialog} title="Edit showcase" size="xl">
      {isLoading || !data ? (
        <div className="flex justify-center p-8">
          <Loader />
        </div>
      ) : (
        <Stack>
          <SegmentedControl
            value={site}
            onChange={(value) => setSite(value as VersionShowcaseSite)}
            data={[
              { value: 'red', label: siteLabel.red },
              { value: 'com', label: siteLabel.com },
            ]}
          />
          <Text size="sm" c="dimmed">
            Drag to reorder what {siteLabel[site]} shows for this version. The first image on the
            latest version is the model&apos;s {siteLabel[site]} cover. You can feature up to{' '}
            {VERSION_SHOWCASE_LIMIT} images by other creators; their authors are credited and can
            remove them.
            {site === 'com' && ' civitai.com only shows images rated PG or PG-13.'}
          </Text>
          {!data.isLatestPublished && (
            <Alert color="blue" p="xs">
              <Text size="xs">
                Covers come from the latest published version&apos;s showcase. Reordering this one
                only changes its carousel.
              </Text>
            </Alert>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={items.map((item) => item.imageId)}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {items.map((item) => (
                  <SortableItem key={item.imageId} id={item.imageId}>
                    <div
                      className={clsx(
                        'relative overflow-hidden rounded-md border-2 border-solid',
                        item.imageId === cover ? 'border-blue-5' : 'border-transparent',
                        item.excluded && 'opacity-40'
                      )}
                    >
                      {item.url ? (
                        <EdgeMedia2
                          src={item.url}
                          type={(item.type ?? 'image') as never}
                          metadata={item.metadata as never}
                          width={160}
                          anim={false}
                          className="aspect-square w-full object-cover"
                        />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-gray-2 dark:bg-dark-5">
                          <Text size="xs">#{item.imageId}</Text>
                        </div>
                      )}
                      <Group gap={4} className="absolute left-1 top-1">
                        {item.imageId === cover && <Badge size="xs">Cover</Badge>}
                        {item.source === 'Community' && (
                          <Badge size="xs" color="gray">
                            {item.author ? `by ${item.author}` : 'Community'}
                          </Badge>
                        )}
                      </Group>
                      <Group gap={4} className="absolute bottom-1 right-1">
                        {canBeCover(item) && item.imageId !== cover && (
                          <Tooltip label="Make this the cover">
                            <ActionIcon
                              size="sm"
                              variant="filled"
                              aria-label={`Make image ${item.imageId} the ${siteLabel[site]} cover`}
                              loading={setCover.isPending}
                              onClick={() =>
                                setCover.mutate({
                                  modelId: data.modelId,
                                  site,
                                  imageId: item.imageId,
                                })
                              }
                            >
                              <IconPhotoStar size={14} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                        {item.source === 'Owner' ? (
                          <Tooltip label={item.excluded ? 'Show' : 'Hide'}>
                            <ActionIcon
                              size="sm"
                              variant="filled"
                              aria-label={`${item.excluded ? 'Show' : 'Hide'} image ${
                                item.imageId
                              }`}
                              onClick={() =>
                                setItems((current) =>
                                  current.map((row) =>
                                    row.imageId === item.imageId
                                      ? { ...row, excluded: !row.excluded }
                                      : row
                                  )
                                )
                              }
                            >
                              {item.excluded ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                            </ActionIcon>
                          </Tooltip>
                        ) : (
                          <Tooltip label="Remove">
                            <ActionIcon
                              size="sm"
                              variant="filled"
                              color="red"
                              aria-label={`Remove image ${item.imageId}`}
                              onClick={() =>
                                setItems((current) =>
                                  current.filter((row) => row.imageId !== item.imageId)
                                )
                              }
                            >
                              <IconX size={14} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </div>
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <Group align="flex-end">
            <TextInput
              className="flex-1"
              label="Feature an image by another creator"
              description="Paste an image link. It must be made with this version or posted to its gallery."
              value={link}
              onChange={(event) => setLink(event.currentTarget.value)}
              disabled={communityCount >= VERSION_SHOWCASE_LIMIT}
            />
            <Button variant="default" onClick={addFromLink} disabled={!link.trim()}>
              Add
            </Button>
          </Group>
          {items.some((item) => removedByAuthors.has(item.imageId)) && (
            <Text size="xs" c="red">
              An image&apos;s author removed it from your showcase, so it can&apos;t be added again.
            </Text>
          )}
          {cover !== null && (
            <Button
              variant="subtle"
              size="compact-xs"
              className="self-start"
              loading={setCover.isPending}
              onClick={() => setCover.mutate({ modelId: data.modelId, site, imageId: null })}
            >
              Reset the {siteLabel[site]} cover to the default
            </Button>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={dialog.onClose}>
              Close
            </Button>
            <Button
              loading={save.isPending}
              onClick={() =>
                save.mutate({
                  modelVersionId,
                  site,
                  items: items.map((item, index) => ({
                    imageId: item.imageId,
                    position: index,
                    excluded: item.excluded,
                  })),
                })
              }
            >
              Save {siteLabel[site]} showcase
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
