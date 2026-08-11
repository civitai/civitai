import { Anchor, Group, Loader, SegmentedControl, Slider, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  PLACEMENT_PRICE_STEP,
  PLACEMENT_PRICE_TRACK_START,
  PLACEMENT_SURFACES,
} from '~/shared/utils/placement';
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

  const { data: row, isLoading } = trpc.placement.getSpaceRow.useQuery(
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

  const onError = (error: { message: string }) =>
    showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) });

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError,
  });
  const clear = trpc.placement.clearSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError,
  });

  if (!features.stickerPlacement) return null;
  if (isLoading) return <Loader size="xs" />;

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
  // A price set before the track existed, or under an operator cap that has
  // since dropped, must stay reachable — a control that cannot represent the
  // stored value silently rewrites it the first time it is touched.
  const sliderMin = Math.min(PLACEMENT_PRICE_TRACK_START, price === '' ? Infinity : price);
  const sliderMax = Math.max(range?.max ?? defaultPrice, sliderMin, price === '' ? 0 : price);
  const sliderValue = price === '' ? Math.min(Math.max(defaultPrice, sliderMin), sliderMax) : price;

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
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  onClick={() => {
                    setPrice('');
                    commit(mode, '');
                  }}
                >
                  Use the price from the level above
                </Anchor>
              )}
            </Group>
            <Slider
              size="xs"
              // Committing on release rather than on every value: dragging a
              // slider emits a value per pixel, and each one is a write. This is
              // also why there is no debounce — a trailing timer can still land
              // after the pointer is up, and `onChangeEnd` cannot drop the value
              // the creator actually chose.
              value={sliderValue}
              // Until the range loads, the ceiling is a guess, and a creator who
              // drags against the guess sets a price against a cap that is not
              // theirs.
              disabled={!range}
              min={sliderMin}
              max={sliderMax}
              step={PLACEMENT_PRICE_STEP}
              marks={[
                { value: sliderMin, label: `${sliderMin}` },
                { value: sliderMax, label: `${sliderMax}` },
              ]}
              label={(value) => `${value} Buzz`}
              onChange={setPrice}
              onChangeEnd={(value) => {
                setPrice(value);
                commit(mode, value);
              }}
            />
            <Text size="xs" c="dimmed">
              {price === ''
                ? `Following the price from the level above, or ${defaultPrice} Buzz if none is set.`
                : `Placers pay ${price} Buzz. Your tier caps this at ${sliderMax}.`}
            </Text>
          </Stack>
        )
      )}
    </Stack>
  );
}
