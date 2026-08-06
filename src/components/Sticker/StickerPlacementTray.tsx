import { Alert, Button, Group, ScrollArea, Text } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useImagePlacementSpace } from '~/components/Sticker/placement.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  pointerOverSurface,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';
import { trpc } from '~/utils/trpc';

/**
 * The placement affordance: a strip along the bottom of the viewport holding the
 * stickers you own, which you drag onto the image.
 *
 * Deliberately not a modal. A modal has to show its own copy of the image, which
 * is a different size from the real one and puts a scrollbar between you and the
 * thing you are decorating — you end up positioning a sticker on a picture of
 * the picture. Dragging onto the actual image is both simpler and the only way
 * the result is what you saw.
 */
export function StickerPlacementTray() {
  const currentUser = useCurrentUser();
  const { sticker, isLoading } = useOwnedSticker();

  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const draft = useStickerPlacementDraftStore((state) => state.draft);
  const begin = useStickerPlacementDraftStore((state) => state.begin);
  const close = useStickerPlacementDraftStore((state) => state.close);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);

  const { space } = useImagePlacementSpace(targetImageId ?? undefined);
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null,
  });

  if (targetImageId == null) return null;

  // `null` is unlimited and `undefined` is not loaded yet. Collapsing them
  // flashes "unlimited" on every open.
  const balanceFor = (cosmeticId: number) =>
    balances?.find((balance) => balance.cosmeticId === cosmeticId)?.remaining;

  /**
   * Press a sticker and drag it straight onto the image: the draft is created on
   * pointer-down at the tray, then follows the pointer. Releasing over the image
   * leaves it there, so choosing and positioning are one gesture rather than two
   * steps with a modal in between.
   */
  const grab = (cosmeticId: number) => (event: React.PointerEvent) => {
    event.preventDefault();
    // Undefined when the press is outside the image, which it always is on the
    // first grab — the draft then starts centred and follows the pointer in.
    begin(cosmeticId, pointerOverSurface(event.clientX, event.clientY) ?? undefined);
    setInteraction('move');
  };

  const price = space?.price ?? 0;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-3 bg-white p-3 shadow-lg dark:border-dark-4 dark:bg-dark-7">
      <Group justify="space-between" align="start" wrap="nowrap" gap="md">
        <ScrollArea.Autosize mah={110} className="flex-1">
          <Group gap="xs" wrap="nowrap">
            {isLoading && <Text size="sm">Loading your stickers…</Text>}
            {!isLoading && !sticker.length && (
              <Text size="sm" c="dimmed">
                You don&apos;t own any stickers yet.
              </Text>
            )}
            {sticker.map((option) => {
              const remaining = balanceFor(option.id);
              const exhausted = remaining === 0;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={exhausted}
                  onPointerDown={exhausted ? undefined : grab(option.id)}
                  className={clsx(
                    'flex shrink-0 cursor-grab flex-col items-center gap-1 rounded border p-2',
                    draft?.cosmeticId === option.id ? 'border-blue-5' : 'border-transparent',
                    exhausted && 'cursor-not-allowed opacity-40'
                  )}
                  style={{ touchAction: 'none' }}
                >
                  <EdgeImage
                    src={option.url}
                    alt={`:${option.slug}:`}
                    options={{ height: 96, anim: option.animated, optimized: true }}
                    style={{ height: 48, width: 'auto', pointerEvents: 'none' }}
                    draggable={false}
                  />
                  <Text size="10px">{remaining === null ? '∞' : remaining ?? '…'}</Text>
                </button>
              );
            })}
          </Group>
        </ScrollArea.Autosize>

        <div className="shrink-0">
          <Group gap="xs" align="center">
            <Text size="sm">
              <Text span fw={700}>
                {price}
              </Text>{' '}
              Buzz + one use
            </Text>
            <Button variant="subtle" color="gray" onClick={close} leftSection={<IconX size={16} />}>
              Cancel
            </Button>
          </Group>

          {space?.mode === 'review' && (
            <Alert color="yellow" p={6} mt={6} maw={340}>
              <Text size="xs">
                This creator reviews placements. Only you see it until they approve — and if they
                decline, part of what you paid stays with them.
              </Text>
            </Alert>
          )}

          <Text size="xs" c="dimmed" mt={6}>
            {draft
              ? 'Drag it where you want it, then press Place under the sticker.'
              : 'Drag a sticker onto the image.'}
          </Text>
        </div>
      </Group>
    </div>
  );
}
