import { Alert, Button, Group, Modal, Skeleton, Stack, Text } from '@mantine/core';
import { useDebouncedCallback } from '@mantine/hooks';
import { IconCheck, IconPhoto } from '@tabler/icons-react';
import clsx from 'clsx';
import { useId, useState } from 'react';
import { HeroPositionPicker } from '~/components/Comics/HeroPositionPicker';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import { ImageSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

type Storyline = RouterOutput['storyline']['getById'];
type Slot = 'cover' | 'banner';

/** The image read's page size, and so how many images the picker can offer. */
const PICKER_IMAGE_LIMIT = 200;

/**
 * The owner's picks for the storyline's card cover and page banner, as one row of the Manage
 * modal's settings. Each pick is saved as soon as it is made; the server has the last word on
 * which images may be used, and its refusal is shown here.
 */
export function StorylineCoversRow({ storylineId }: { storylineId: number }) {
  const utils = trpc.useUtils();
  const { data: storyline } = trpc.storyline.getById.useQuery({ id: storylineId });
  const [error, setError] = useState<string | null>(null);
  // Follows the drag; the server's value until the owner moves it.
  const [position, setPosition] = useState<number | null>(null);

  const update = trpc.storyline.update.useMutation({
    onMutate: () => setError(null),
    onSuccess: (_data, input) =>
      Promise.all([
        utils.storyline.getById.invalidate({ id: storylineId }),
        // The feed's cards show the cover, and nothing else this row sets.
        'coverImageId' in input ? utils.storyline.getInfinite.invalidate() : undefined,
      ]),
    onError: (e) => setError(e.message),
  });
  // Saved once the drag pauses, and on closing Manage mid-drag.
  const savePosition = useDebouncedCallback(
    (heroImagePosition: number) => update.mutate({ id: storylineId, heroImagePosition }),
    { delay: 400, flushOnUnmount: true }
  );

  if (!storyline) return null;
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
          Pictures from your chapters and your endorsed collaborators&apos; chapters.
        </Text>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <CoverSlot
          label="Card cover"
          onChange={() => openPicker('cover')}
          onReset={storyline.coverImageId != null ? () => save({ coverImageId: null }) : undefined}
          resetLabel="Use chapter 1"
          disabled={update.isPending}
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
          disabled={update.isPending}
        >
          {storyline.heroIsBanner && storyline.heroImage ? (
            // The owner's own blur preferences apply here as on the page.
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
  disabled,
  children,
}: {
  label: string;
  onChange: () => void;
  /** Only when something is picked. */
  onReset?: () => void;
  resetLabel: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <Text size="xs" fw={700} c="dimmed">
        {label}
      </Text>
      {children}
      <Group gap="xs">
        <Button size="compact-sm" variant="default" onClick={onChange} disabled={disabled}>
          Change
        </Button>
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
 * The images the server would accept, grouped by chapter: the canon path's chapters by the owner
 * or an endorsed collaborator, rated within the ceiling, and no minors or real people. Read
 * through the normal image read, so the owner's own level and hidden images apply as well.
 */
function StorylineImagePicker({
  storyline,
  initialId,
  confirmLabel,
  onCancel,
  onPick,
}: {
  storyline: Storyline;
  initialId: number | null;
  confirmLabel: string;
  onCancel: () => void;
  onPick: (imageId: number) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(initialId);
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
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4]" />
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

function ChapterImages({
  number,
  images,
  selectedId,
  onSelect,
}: {
  number: number;
  images: StorylineThumbImage[];
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
        className="grid grid-cols-3 gap-2 sm:grid-cols-4"
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
              <StorylineThumb image={image} width={120} fluid>
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
