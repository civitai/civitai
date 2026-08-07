import { CloseButton, Group, ScrollArea, Text } from '@mantine/core';
import clsx from 'clsx';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { useImagePlacementSpace } from '~/components/Sticker/placement.util';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  pointerOverSurface,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';
import { trpc } from '~/utils/trpc';

/**
 * The placement affordance: a panel at the bottom of the viewport holding the
 * stickers you own, which you drag onto the image.
 *
 * Deliberately not a modal. A modal has to show its own copy of the image, at a
 * different size from the real one and behind a scrollbar — you end up
 * positioning a sticker on a picture of the picture. Dragging onto the actual
 * image is both simpler and the only way the result is what you saw.
 *
 * Centred and capped rather than spanning the viewport: full-width made a row of
 * three stickers sit in a field of empty panel, and pushed the instructions so
 * far from them that they read as unrelated.
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
    begin(
      cosmeticId,
      pointerOverSurface(event.clientX, event.clientY) ?? undefined,
      stickerMaxScale(space?.settings as Record<string, unknown> | undefined)
    );
    setInteraction('move');
  };

  const price = space?.price ?? 0;
  const instruction = draft
    ? 'Drag it where you want it, then buy it under the sticker.'
    : 'Drag a sticker onto the image.';

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center p-3">
      <div className="w-full max-w-xl overflow-hidden rounded-lg border border-gray-3 bg-white shadow-lg dark:border-dark-4 dark:bg-dark-7">
        <div className="flex items-start gap-2 border-b border-gray-3 px-3 py-2 dark:border-dark-4">
          <div className="flex-1">
            <Text size="sm" fw={600}>
              {instruction}
            </Text>
            <Text size="xs" c="dimmed">
              {price} Buzz + one use
              {space?.mode === 'review' &&
                ' · this creator reviews placements, so only you will see it until they approve. If they decline, part of what you paid stays with them.'}
            </Text>
          </div>
          <CloseButton onClick={close} aria-label="Cancel placing a sticker" />
        </div>

        <ScrollArea.Autosize mah={120} type="auto" scrollbarSize={6}>
          <Group gap="xs" wrap="nowrap" p="xs">
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
      </div>
    </div>
  );
}
