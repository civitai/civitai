import { Loader, NumberInput, SegmentedControl, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
      price: nextPrice === '' ? undefined : nextPrice,
    });
  };

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
          <NumberInput
            size="xs"
            label="Price"
            description="Leave empty to use the price from the level above."
            value={price}
            min={0}
            onChange={(value) => setPrice(typeof value === 'number' ? value : '')}
            onBlur={() => commit(mode, price)}
          />
        )
      )}
    </Stack>
  );
}
