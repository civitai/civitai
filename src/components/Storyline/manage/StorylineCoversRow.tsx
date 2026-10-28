import { Alert, Button, FileButton, Group, Modal, Skeleton, Stack, Text } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { IconCheck, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { useId, useState } from 'react';
import { HeroPositionPicker } from '~/components/Comics/HeroPositionPicker';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useQueryImages } from '~/components/Image/image.utils';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import {
  coverPickerTile,
  type CoverSlot,
} from '~/components/Storyline/storyline-cover-picker.utils';
import { ImageSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type Storyline = RouterOutput['storyline']['getById'];
type Slot = CoverSlot;

const PICKER_IMAGE_LIMIT = 200;

/**
 * Each pick is saved as soon as it is made; the server decides which images may be used and its
 * refusal is shown here.
 */
export function StorylineCoversRow({ storylineId }: { storylineId: number }) {
  const utils = trpc.useUtils();
  const { data: storyline } = trpc.storyline.getById.useQuery({ id: storylineId });
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);

  const update = trpc.storyline.update.useMutation({
    onMutate: () => setError(null),
    onSuccess: (_data, input) =>
      Promise.all([
        utils.storyline.getById.invalidate({ id: storylineId }),
        // The feed's cards show the cover, and nothing else this row sets.
        'coverImageId' in input || 'coverUpload' in input
          ? utils.storyline.getInfinite.invalidate()
          : undefined,
      ]),
    onError: (e) => setError(e.message),
  });
  const savePosition = useDebouncedCallback(
    (heroImagePosition: number) => update.mutate({ id: storylineId, heroImagePosition }),
    { delay: 400, flushOnUnmount: true }
  );

  const { uploadToCF } = useCFImageUpload();
  const [uploading, setUploading] = useState<Slot | null>(null);

  if (!storyline) return null;
  // The file goes up first; the server then makes it an image of the uploader and scans it.
  const upload = async (slot: Slot, file: File | null) => {
    if (!file) return;
    setUploading(slot);
    setError(null);
    try {
      const result = await uploadToCF(file);
      const image = {
        url: result.id,
        width: result.width,
        height: result.height,
        hash: result.hash,
        mimeType: result.mimeType,
        type: 'image' as const,
      };
      if (slot === 'banner') {
        savePosition.flush();
        setPosition(null);
        update.mutate({ id: storylineId, heroUpload: image });
      } else update.mutate({ id: storylineId, coverUpload: image });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'The upload failed. Try again.');
    } finally {
      setUploading(null);
    }
  };
  const save = (picks: { coverImageId?: number | null; heroImageId?: number | null }) =>
    update.mutate({ id: storylineId, ...picks });
  // On the dialog stack, so it opens above the Manage modal this row sits in.
  const openPicker = (slot: Slot) =>
    dialogStore.trigger({
      component: StorylineImagePickerModal,
      props: {
        storyline,
        slot,
        onPick: (imageId: number) => {
          if (slot === 'banner') {
            // A focus still waiting to save goes first, so it cannot land after the new banner.
            savePosition.flush();
            setPosition(null);
            save({ heroImageId: imageId });
          } else save({ coverImageId: imageId });
        },
      },
    });

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={500} className="flex items-center gap-1.5">
          <IconPhoto size={16} aria-hidden />
          Covers
        </Text>
        <Text size="xs" c="dimmed">
          Pictures from your chapters and your endorsed collaborators&apos; chapters, or one you
          upload.
        </Text>
      </div>

      <div className="flex flex-wrap items-start gap-5 sm:items-end">
        <CoverSlot
          label="Card cover"
          onChange={() => openPicker('cover')}
          onReset={storyline.coverImageId != null ? () => save({ coverImageId: null }) : undefined}
          resetLabel="Use chapter 1"
          onUpload={(file) => upload('cover', file)}
          uploading={uploading === 'cover'}
          pending={storyline.coverPickHidden}
          disabled={update.isPending || !!uploading}
        >
          <StorylineThumb image={storyline.coverImage} width={96} className="rounded-lg" />
        </CoverSlot>

        <CoverSlot
          label="Banner"
          onChange={() => openPicker('banner')}
          onReset={
            storyline.heroImageId != null
              ? () => {
                  savePosition.flush();
                  setPosition(null);
                  save({ heroImageId: null });
                }
              : undefined
          }
          resetLabel="Remove banner"
          onUpload={(file) => upload('banner', file)}
          uploading={uploading === 'banner'}
          pending={storyline.heroPickHidden}
          disabled={update.isPending || !!uploading}
        >
          {storyline.heroIsBanner && storyline.heroImage ? (
            <ImageGuard2 image={storyline.heroImage} explain={false}>
              {(safe) =>
                safe ? (
                  <HeroPositionPicker
                    url={storyline.heroImage!.url}
                    aspectRatio="16 / 6"
                    position={position ?? storyline.heroImagePosition}
                    onPositionChange={(next) => {
                      setPosition(next);
                      savePosition(next);
                    }}
                    className="w-[240px] max-w-full"
                  />
                ) : (
                  <div
                    className="relative aspect-[16/6] w-[240px] max-w-full overflow-hidden rounded-lg"
                    data-testid="storyline-banner-hidden"
                  >
                    <MediaHash {...storyline.heroImage!} className="absolute inset-0" />
                  </div>
                )
              }
            </ImageGuard2>
          ) : (
            <div className="flex aspect-[16/6] w-[240px] max-w-full items-center justify-center rounded-lg border border-dashed border-gray-4 p-3 text-center dark:border-dark-3">
              <Text size="xs" c="dimmed">
                No banner: the page shows the card cover, blurred.
              </Text>
            </div>
          )}
        </CoverSlot>
      </div>

      {error && (
        <Alert color="red" data-testid="storyline-covers-error">
          <Text size="sm">{error}</Text>
        </Alert>
      )}
    </Stack>
  );
}

function StorylineImagePickerModal({
  storyline,
  slot,
  onPick,
}: {
  storyline: Storyline;
  slot: Slot;
  onPick: (imageId: number) => void;
}) {
  const dialog = useDialogContext();
  const banner = slot === 'banner';
  return (
    <Modal {...dialog} title={banner ? 'Choose the banner' : 'Choose the card cover'} size="lg">
      <StorylineImagePicker
        storyline={storyline}
        slot={slot}
        initialId={banner ? storyline.heroImageId : storyline.coverImageId}
        confirmLabel={banner ? 'Use as banner' : 'Use as card cover'}
        onCancel={dialog.onClose}
        onPick={(imageId) => {
          dialog.onClose();
          onPick(imageId);
        }}
      />
    </Modal>
  );
}

function CoverSlot({
  label,
  onChange,
  onReset,
  resetLabel,
  onUpload,
  uploading,
  pending,
  disabled,
  children,
}: {
  label: string;
  onChange: () => void;
  /** Only when something is picked. */
  onReset?: () => void;
  resetLabel: string;
  onUpload: (file: File | null) => void;
  uploading: boolean;
  /** The pick is not showing yet, usually an upload still being scanned. */
  pending: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <Text size="xs" fw={700} c="dimmed">
        {label}
      </Text>
      {children}
      {pending && (
        <Text size="xs" c="dimmed" className="max-w-[240px]">
          Processing: your pick shows here and on the storyline once its scan clears it.
        </Text>
      )}
      <Group gap="xs">
        <Button size="compact-sm" variant="default" onClick={onChange} disabled={disabled}>
          Change
        </Button>
        <FileButton onChange={onUpload} accept="image/png,image/jpeg,image/webp">
          {(props) => (
            <Button
              {...props}
              size="compact-sm"
              variant="default"
              loading={uploading}
              disabled={disabled && !uploading}
            >
              Upload
            </Button>
          )}
        </FileButton>
        {onReset && (
          <Button
            size="compact-sm"
            variant="subtle"
            color="gray"
            onClick={onReset}
            disabled={disabled}
          >
            {resetLabel}
          </Button>
        )}
      </Group>
    </div>
  );
}

/**
 * The images the server accepts for a cover or banner, grouped by chapter. Read through the normal
 * image read, so the owner's own level and hidden images apply as well.
 */
export function StorylineImagePicker({
  storyline,
  slot,
  initialId,
  confirmLabel,
  onCancel,
  onPick,
}: {
  storyline: Storyline;
  slot: Slot;
  initialId: number | null;
  confirmLabel: string;
  onCancel: () => void;
  onPick: (imageId: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(initialId);
  const tile = coverPickerTile(slot, storyline.heroImagePosition);
  const authors = new Set([storyline.userId, ...storyline.collaborators.map((c) => c.id)]);
  const chapters = storyline.mainPath.flatMap((chapter) =>
    chapter.post && authors.has(chapter.post.userId)
      ? [{ number: chapter.depth + 1, postId: chapter.post.id }]
      : []
  );
  const { images, isLoading, isError } = useQueryImages(
    {
      postIds: chapters.map((c) => c.postId),
      limit: PICKER_IMAGE_LIMIT,
      sort: ImageSort.Oldest,
      period: MetricTimeframe.AllTime,
      withMeta: false,
      include: [],
    },
    { enabled: chapters.length > 0 }
  );
  const allowed = images.filter(
    (image) =>
      !image.minor &&
      !image.poi &&
      storylineLevelAllowed({ postLevel: image.nsfwLevel, maxNsfwLevel: storyline.maxNsfwLevel })
  );
  const groups = chapters
    .map((chapter) => ({
      ...chapter,
      images: allowed.filter((image) => image.postId === chapter.postId),
    }))
    .filter((group) => group.images.length);

  return (
    <Stack gap="md">
      {chapters.length > 0 && isLoading ? (
        <div className={clsx('grid gap-2', tile.columnsClass)}>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton
              key={i}
              className={tile.ratio === '16/6' ? 'aspect-[16/6]' : 'aspect-[3/4]'}
            />
          ))}
        </div>
      ) : isError ? (
        <Text size="sm" c="red">
          Couldn&apos;t load the chapters&apos; images.
        </Text>
      ) : !groups.length ? (
        <Text size="sm" c="dimmed">
          No images can be used yet. Images must be rated, within this storyline&apos;s maximum
          rating, and from your chapters or your endorsed collaborators&apos;.
        </Text>
      ) : (
        <div className="-m-1 flex max-h-[60vh] flex-col gap-4 overflow-y-auto p-1">
          {groups.map((group) => (
            <ChapterImages
              key={group.postId}
              number={group.number}
              images={group.images}
              tile={tile}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ))}
          {images.length >= PICKER_IMAGE_LIMIT && (
            <Text size="xs" c="dimmed">
              The first {PICKER_IMAGE_LIMIT} images.
            </Text>
          )}
        </div>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={selectedId == null || selectedId === initialId}
          onClick={() => selectedId != null && onPick(selectedId)}
        >
          {confirmLabel}
        </Button>
      </Group>
    </Stack>
  );
}

export function ChapterImages({
  number,
  images,
  tile,
  selectedId,
  onSelect,
}: {
  number: number;
  images: StorylineThumbImage[];
  tile: ReturnType<typeof coverPickerTile>;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const labelId = useId();
  return (
    <section>
      <Text size="xs" fw={700} c="dimmed" mb={6} id={labelId}>
        Chapter {number}
      </Text>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        className={clsx('grid gap-2', tile.columnsClass)}
      >
        {images.map((image, i) => {
          const selected = image.id === selectedId;
          return (
            <button
              key={image.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Chapter ${number}, image ${i + 1}`}
              onClick={() => onSelect(image.id)}
              className={clsx(
                'rounded-lg p-0.5 outline-none',
                'focus-visible:ring-2 focus-visible:ring-blue-5/50',
                selected && 'ring-2 ring-blue-5 focus-visible:ring-blue-5'
              )}
            >
              <StorylineThumb
                image={image}
                width={tile.ratio === '16/6' ? 240 : 120}
                ratio={tile.ratio}
                focusY={tile.focusY}
                fluid
              >
                {selected && (
                  <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-blue-6 text-white">
                    <IconCheck size={14} stroke={3} />
                  </span>
                )}
              </StorylineThumb>
            </button>
          );
        })}
      </div>
    </section>
  );
}
