import {
  Alert,
  Anchor,
  Divider,
  Group,
  SegmentedControl,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { SettingsSection } from '~/components/Account/SettingsLayout';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  placementPriceCaption,
  PLACEMENT_MIN_PRICE,
  PLACEMENT_SURFACES,
  resolveHostDeclineFeePercent,
} from '~/shared/utils/placement';
import type { PlacementSpaceSettings } from '~/shared/utils/placement';
import type { PromotionSurface } from '~/shared/utils/promotion';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const COPY: Record<PromotionSurface, { title: string; about: string; off: string }> = {
  galleryPromotion: {
    title: 'Sponsored posts in your model galleries',
    about:
      'Creators who made a post with your model can pay to show it in that model’s gallery for a few days, marked Sponsored. You review each one, and you are paid when you accept.',
    off: 'No sponsored posts',
  },
  modelPromotion: {
    title: 'Sponsored models in your Suggested Resources',
    about:
      'Other creators can pay to show one of their models in your model pages’ Suggested Resources for a few days, marked Sponsored. You review each one, and you are paid when you accept.',
    off: 'No sponsored models',
  },
};

/** One promotion surface's account-level mode and daily price. */
function PromotionSurfaceSettings({
  surface,
  flat,
}: {
  surface: PromotionSurface;
  flat?: boolean;
}) {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const { data: range } = trpc.placement.getPriceRange.useQuery({ surface });
  const { data: spaces } = trpc.placement.getMySpaces.useQuery({ surface });

  const stored = spaces?.[0];
  // Seeded from the surface default: a host with no row is open, and seeding
  // 'off' would write that opt-out the first time they touched the price.
  const [mode, setMode] = useState<string>(PLACEMENT_SURFACES[surface].defaultMode);
  const [price, setPrice] = useState<number | ''>('');
  const declineRange = PLACEMENT_SURFACES[surface].hostDeclineFeePercent;
  const [declineFee, setDeclineFee] = useState(() =>
    resolveHostDeclineFeePercent(surface, undefined)
  );

  useEffect(() => {
    if (!stored) return;
    setMode(stored.mode);
    setPrice(stored.price ?? '');
    setDeclineFee(
      resolveHostDeclineFeePercent(surface, (stored.settings ?? {}) as PlacementSpaceSettings)
    );
  }, [stored, surface]);

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) }),
  });

  if (!currentUser) return null;

  const cap = range?.max ?? 0;
  const defaultPrice = PLACEMENT_SURFACES[surface].defaultPrice ?? PLACEMENT_MIN_PRICE;
  const overCap = typeof price === 'number' && cap > 0 && price > cap;
  const caption = placementPriceCaption(
    surface,
    price === '' ? defaultPrice : price,
    range?.max ?? null,
    'Promoters'
  );

  const commit = (nextMode: string, nextPrice: number | '') =>
    save.mutate({
      surface,
      entityType: 'user',
      entityId: currentUser.id,
      mode: nextMode as 'off' | 'review',
      price: nextPrice === '' ? null : nextPrice,
    });

  const commitDeclineFee = (value: number) =>
    save.mutate({
      surface,
      entityType: 'user',
      entityId: currentUser.id,
      mode: mode as 'off' | 'review',
      declineFeePercent: value,
    });

  const heading = (
    <Group gap={4} wrap="nowrap">
      {COPY[surface].title}
      <InfoPopover size="xs" iconProps={{ size: 14 }} width={340}>
        <Text size="sm" maw={320} style={{ whiteSpace: 'normal' }}>
          {COPY[surface].about}
        </Text>
      </InfoPopover>
    </Group>
  );

  const body = (
    <>
      <SegmentedControl
        value={mode}
        onChange={(value) => {
          setMode(value);
          commit(value, price);
        }}
        data={[
          { value: 'off', label: COPY[surface].off },
          { value: 'review', label: 'Review each one' },
        ]}
      />
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm" fw={500}>
            Price per day
          </Text>
          {price !== '' && (
            <Anchor component="button" type="button" size="xs" onClick={() => commit(mode, '')}>
              Use the platform default
            </Anchor>
          )}
        </Group>
        <PlacementPriceSlider
          surface={surface}
          cap={range?.max ?? null}
          value={price}
          fallback={defaultPrice}
          onChange={setPrice}
          onCommit={(value) => {
            setPrice(value);
            commit(mode, value);
          }}
        />
        {caption && (
          <Text size="xs" ta="center" mt={-22} c={caption.warning ? 'yellow' : 'dimmed'}>
            {caption.text}
          </Text>
        )}
      </Stack>
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Kept if you decline
        </Text>
        <Slider
          min={declineRange.min}
          max={declineRange.max}
          step={1}
          value={declineFee}
          // The save resends `mode`, which reads the surface default until the
          // stored row loads — releasing early would reopen a space turned off.
          disabled={!spaces}
          onChange={setDeclineFee}
          onChangeEnd={commitDeclineFee}
          label={(value) => `${value}%`}
          thumbLabel={`${COPY[surface].title}: kept if you decline`}
          marks={[0, 10, 20, 30].map((value) => ({ value, label: `${value}%` }))}
          mb="md"
        />
        <Text size="xs" c="dimmed">
          {declineFee === 0
            ? 'Buyers get all of their Buzz back when you decline.'
            : `You keep ${declineFee}% of what a buyer paid when you decline, and they get the rest back.`}{' '}
          Raise it if you are getting unwanted requests.
        </Text>
      </Stack>
      {overCap && (
        <Alert color="yellow" p="xs">
          <Text size="xs">
            You&apos;ll be charging {cap} Buzz a day, your current cap, until your score or
            membership raises it.
          </Text>
        </Alert>
      )}
    </>
  );

  if (flat)
    return (
      <SettingsSection title={heading}>
        <div className="flex flex-col gap-4">{body}</div>
      </SettingsSection>
    );

  return (
    <>
      <Divider label={heading} />
      {body}
    </>
  );
}

/** Both promotion surfaces, priced separately. Renders nothing while the flag is off. */
export function PromotionSettings({ flat }: { flat?: boolean } = {}) {
  const features = useFeatureFlags();
  if (!features.creatorPromotions) return null;

  return (
    <>
      <PromotionSurfaceSettings surface="galleryPromotion" flat={flat} />
      <PromotionSurfaceSettings surface="modelPromotion" flat={flat} />
    </>
  );
}
