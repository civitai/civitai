import { Anchor, Group, Loader, SegmentedControl, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { placementPriceCaption, PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Level = 'post' | 'image';

const COPY: Record<Level, { label: string; inherit: string }> = {
  post: {
    label: 'Stickers on this post',
    inherit: 'Following your account setting',
  },
  image: {
    label: 'Stickers on this image',
    inherit: 'Following the post or your account setting',
  },
};

/**
 * Per-post and per-image override of who may place stickers here.
 *
 * Shows **this level's own row**, not what the image resolves to. An inherited
 * account setting displayed as if it were set here would make turning it off
 * appear to do nothing — the row would be written at a level that was never the
 * one deciding.
 *
 * A post-level row also covers images added to the post later, which is why the
 * levels inherit rather than the post toggle writing a row per image.
 */
export function PlacementSpaceToggle({ level, entityId }: { level: Level; entityId: number }) {
  const features = useFeatureFlags();
  const utils = trpc.useUtils();

  const {
    data: row,
    isPending: rowPending,
    isError: rowFailed,
  } = trpc.placement.getSpaceRow.useQuery(
    { surface: 'sticker', entityType: level, entityId },
    { enabled: !!features.stickerPlacement }
  );
  const { data: range } = trpc.placement.getPriceRange.useQuery(
    { surface: 'sticker' },
    { enabled: !!features.stickerPlacement }
  );

  const [mode, setMode] = useState<string>('inherit');
  const [price, setPrice] = useState<number | ''>('');

  useEffect(() => {
    setMode(row?.mode ?? 'inherit');
    setPrice(row?.price ?? '');
  }, [row]);

  // A refused write leaves the control asserting a price the server did not
  // take. Rolling back to the row is the same failure the price guard exists to
  // prevent, moved from the database to the screen.
  const onError = (error: { message: string }) => {
    setMode(row?.mode ?? 'inherit');
    setPrice(row?.price ?? '');
    showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) });
  };

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError,
  });
  const clear = trpc.placement.clearSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError,
  });

  if (!features.stickerPlacement) return null;
  if (rowPending) return <Loader size="xs" />;
  // `row` is undefined after a failed read exactly as it is for a level with no
  // row of its own, and the control cannot tell them apart. Showing `inherit`
  // means one click clears or overwrites a setting the creator never saw.
  if (rowFailed) return null;

  const commit = (nextMode: string, nextPrice: number | '') => {
    // Inheriting is the absence of a row, so it deletes rather than writing
    // `off`. Those are different statements — off is a deliberate no here,
    // inherit defers to the level above — and writing one for the other means an
    // owner who later changes their account setting finds this level quietly
    // ignoring it.
    if (nextMode === 'inherit') {
      clear.mutate({ surface: 'sticker', entityType: level, entityId });
      return;
    }

    save.mutate({
      surface: 'sticker',
      entityType: level,
      entityId,
      mode: nextMode as 'off' | 'review' | 'auto',
      // `null` clears and inherits; `undefined` means "leave whatever is set".
      // Sending undefined here made an emptied field keep charging the old price
      // while the copy said it was inheriting.
      price: nextPrice === '' ? null : nextPrice,
    });
  };

  const defaultPrice = PLACEMENT_SURFACES.sticker.defaultPrice;
  const cap = range?.max ?? null;
  const caption = typeof price === 'number' ? placementPriceCaption('sticker', price, cap) : null;

  return (
    <Stack gap={4}>
      <Text size="xs" fw={600}>
        {COPY[level].label}
      </Text>
      <SegmentedControl
        size="xs"
        value={mode}
        onChange={(value) => {
          setMode(value);
          commit(value, price);
        }}
        data={[
          { value: 'inherit', label: 'Default' },
          { value: 'off', label: 'Off' },
          { value: 'review', label: 'Review' },
          { value: 'auto', label: 'Accept' },
        ]}
      />

      {mode === 'inherit' ? (
        <Text size="xs" c="dimmed">
          {COPY[level].inherit}
        </Text>
      ) : (
        mode !== 'off' && (
          <Stack gap={2}>
            <Group justify="space-between" gap="xs">
              <Text size="xs" fw={500}>
                Price
              </Text>
              {price !== '' && (
                <Anchor component="button" type="button" size="xs" onClick={() => commit(mode, '')}>
                  Use the price from the level above
                </Anchor>
              )}
            </Group>
            <PlacementPriceSlider
              size="xs"
              surface="sticker"
              cap={cap}
              value={price}
              fallback={defaultPrice}
              onChange={setPrice}
              onCommit={(value) => {
                setPrice(value);
                commit(mode, value);
              }}
            />
            {/* Pulled up into the row the marks already reserve and centred
                between them, so the caption costs no extra height. */}
            {(price === '' || caption) && (
              <Text size="xs" ta="center" mt={-22} c={caption?.warning ? 'yellow' : 'dimmed'}>
                {price === ''
                  ? `Following the price from the level above, or ${defaultPrice} Buzz if none is set.`
                  : caption?.text}
              </Text>
            )}
          </Stack>
        )
      )}
    </Stack>
  );
}
