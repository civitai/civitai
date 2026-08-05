import { Alert, Button, Group, Modal, ScrollArea, Slider, Stack, Text } from '@mantine/core';
import clsx from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  STICKER_PLACEMENT_DEFAULT_SCALE,
  STICKER_PLACEMENT_MAX_ROTATION,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';

/**
 * Choose a sticker, drag it onto the image, size it, and pay.
 *
 * The drag works in fractions of the rendered bounds rather than pixels, so what
 * is stored is what everyone else will see at whatever size the image is drawn.
 * Sizing is capped: a creator who accepted a sticker has not accepted having
 * their work covered.
 */
export function StickerPlacementEditor({
  imageId,
  imageUrl,
  price,
  requiresReview,
  onClose,
}: {
  imageId: number;
  imageUrl: string;
  price: number;
  requiresReview: boolean;
  onClose: () => void;
}) {
  const currentUser = useCurrentUser();
  const { sticker, isLoading } = useOwnedSticker();
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const [selected, setSelected] = useState<number | null>(null);
  const [position, setPosition] = useState({ x: 0.5, y: 0.5 });
  const [scale, setScale] = useState(STICKER_PLACEMENT_DEFAULT_SCALE);
  const [rotation, setRotation] = useState(0);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const create = trpc.placement.createSticker.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Sticker placed',
        message:
          result.status === 'pending'
            ? 'Only you can see it until the creator approves it.'
            : 'It is live on the image now.',
      });
      await utils.placement.invalidate();
      onClose();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't place that sticker",
        error: new Error(error.message),
      }),
  });

  /**
   * Pointer position as a fraction of the rendered image, which is what gets
   * stored. Reading the box on every move rather than caching it keeps the drag
   * correct when the modal reflows — a cached box silently offsets every
   * subsequent drag, and it looks like the sticker lagging the cursor.
   */
  const moveTo = useCallback((event: { clientX: number; clientY: number }) => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    setPosition({
      x: Math.min(Math.max((event.clientX - bounds.left) / bounds.width, 0), 1),
      y: Math.min(Math.max((event.clientY - bounds.top) / bounds.height, 0), 1),
    });
  }, []);

  const balanceFor = (cosmeticId: number) => {
    const entry = balances?.find((balance) => balance.cosmeticId === cosmeticId);
    // `null` is unlimited and `undefined` is "not loaded yet". Collapsing them
    // would flash "unlimited" on every open.
    if (!entry) return undefined;
    return entry.remaining;
  };

  const selectedBalance = selected == null ? undefined : balanceFor(selected);
  const exhausted = selectedBalance === 0;

  return (
    <Modal opened onClose={onClose} size="xl" title="Place a sticker" centered>
      <Stack gap="md">
        <div
          ref={surfaceRef}
          className="relative w-full cursor-crosshair select-none overflow-hidden rounded"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            moveTo(event);
          }}
          onPointerMove={(event) => {
            if (event.buttons === 1) moveTo(event);
          }}
        >
          <EdgeImage src={imageUrl} alt="" options={{ width: 900 }} className="w-full" />

          {selected != null && (
            <StickerGhost
              cosmeticId={selected}
              position={position}
              scale={scale}
              rotation={rotation}
            />
          )}
        </div>

        <Text size="sm" c="dimmed">
          Drag on the image to position your sticker.
        </Text>

        <Stack gap={4}>
          <Text size="xs" fw={600}>
            Size
          </Text>
          <Slider
            value={scale}
            onChange={setScale}
            min={STICKER_PLACEMENT_MIN_SCALE}
            max={STICKER_PLACEMENT_MAX_SCALE}
            step={0.01}
            label={(value) => `${Math.round(value * 100)}%`}
          />
          <Text size="xs" fw={600}>
            Rotation
          </Text>
          <Slider
            value={rotation}
            onChange={setRotation}
            min={-STICKER_PLACEMENT_MAX_ROTATION}
            max={STICKER_PLACEMENT_MAX_ROTATION}
            step={1}
            label={(value) => `${value}°`}
          />
        </Stack>

        <ScrollArea.Autosize mah={140}>
          <Group gap="xs">
            {isLoading && <Text size="sm">Loading your stickers…</Text>}
            {!isLoading && !sticker.length && (
              <Text size="sm" c="dimmed">
                You don&apos;t own any stickers yet.
              </Text>
            )}
            {sticker.map((option) => {
              const remaining = balanceFor(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setSelected(option.id)}
                  disabled={remaining === 0}
                  className={clsx(
                    'flex flex-col items-center gap-1 rounded border p-2',
                    selected === option.id ? 'border-blue-5' : 'border-transparent',
                    remaining === 0 && 'opacity-40'
                  )}
                >
                  <EdgeImage
                    src={option.url}
                    alt={`:${option.slug}:`}
                    options={{ height: 96, anim: option.animated, optimized: true }}
                    style={{ height: 48, width: 'auto' }}
                  />
                  <Text size="10px">{remaining === null ? '∞' : remaining ?? '…'}</Text>
                </button>
              );
            })}
          </Group>
        </ScrollArea.Autosize>

        {requiresReview && (
          <Alert color="yellow" p="xs">
            <Text size="xs">
              This creator reviews placements. Only you will see it until they approve it — and if
              they decline, part of what you paid stays with them.
            </Text>
          </Alert>
        )}

        <Group justify="space-between">
          <Text size="sm">
            <Text span fw={700}>
              {price}
            </Text>{' '}
            Buzz, plus one use of the sticker
          </Text>
          <Group gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={create.isPending}
              disabled={selected == null || exhausted}
              onClick={() =>
                selected != null &&
                create.mutate({
                  imageId,
                  data: { cosmeticId: selected, ...position, scale, rotation },
                })
              }
            >
              Place for {price} Buzz
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function StickerGhost({
  cosmeticId,
  position,
  scale,
  rotation,
}: {
  cosmeticId: number;
  position: { x: number; y: number };
  scale: number;
  rotation: number;
}) {
  const { sticker } = useOwnedSticker();
  const art = sticker.find((option) => option.id === cosmeticId);
  if (!art) return null;

  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${position.x * 100}%`,
        top: `${position.y * 100}%`,
        width: `${scale * 100}%`,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
      }}
    >
      <EdgeImage
        src={art.url}
        alt={`:${art.slug}:`}
        options={{ width: 512, anim: art.animated, optimized: true }}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      />
    </div>
  );
}
