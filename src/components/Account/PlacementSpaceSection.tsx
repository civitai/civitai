import {
  Alert,
  Anchor,
  Badge,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import {
  STICKER_PLACEMENT_DEFAULT_MAX_SCALE,
  STICKER_PLACEMENT_MAX_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
  stickerMaxScale,
} from '~/shared/utils/sticker-placement';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const { defaultMode: DEFAULT_MODE, defaultPrice: DEFAULT_PRICE } = PLACEMENT_SURFACES.sticker;

/**
 * Account-level control over who may place stickers on this creator's images.
 *
 * Sits **above** the Creator Program gate in `CreatorControlsCard`: metric
 * privacy and donation goals are membership benefits, this is not.
 *
 * The price the creator sets is what gets stored; the cap is computed at read
 * from their score and membership tier, so a lapse or a score change moves it
 * immediately. Clamping the input here would make the stored number silently
 * disagree with what they typed the moment their tier changed.
 */
export function PlacementSpaceSection() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const enabled = !!features.stickerPlacement;
  const { data: range } = trpc.placement.getPriceRange.useQuery(
    { surface: 'sticker' },
    { enabled }
  );
  const { data: spaces, isPending: spacesPending } = trpc.placement.getMySpaces.useQuery(
    { surface: 'sticker' },
    { enabled }
  );
  const { data: pending } = trpc.placement.getPending.useQuery(undefined, { enabled });

  const stored = spaces?.[0];
  // Seeded from the surface defaults, not from `off`. With no row the cascade
  // resolves this space open, and a control that showed "No stickers" would be
  // telling a creator their space is closed on the one screen where they say so
  // — they would find out it was open from a review notification.
  const [mode, setMode] = useState<string>(DEFAULT_MODE);
  const [price, setPrice] = useState<number | ''>(DEFAULT_PRICE ?? '');
  const [maxScale, setMaxScale] = useState(STICKER_PLACEMENT_DEFAULT_MAX_SCALE);

  useEffect(() => {
    if (!stored) {
      setMode(DEFAULT_MODE);
      setPrice(DEFAULT_PRICE ?? '');
      return;
    }
    setMode(stored.mode);
    setPrice(stored.price ?? '');
    setMaxScale(stickerMaxScale(stored.settings as Record<string, unknown>));
  }, [stored]);

  const save = trpc.placement.setSpace.useMutation({
    // No success toast: every control here commits on change, and three toasts
    // for three nudges of one slider is noise rather than confirmation.
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) => {
      // Without this the field keeps the value the server refused, and the page
      // states a price nobody is being charged.
      setMode(stored?.mode ?? DEFAULT_MODE);
      setPrice(stored?.price ?? DEFAULT_PRICE ?? '');
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) });
    },
  });

  if (!enabled || !currentUser) return null;
  // `spaces` is undefined while in flight and indistinguishable from "no row",
  // so committing against it during the load window would write the seeded
  // default over a space the creator had explicitly closed.
  if (spacesPending) return null;

  const cap = range?.max ?? 0;
  const overCap = typeof price === 'number' && cap > 0 && price > cap;
  const waiting = pending?.length ?? 0;

  const commit = (nextMode: string, nextPrice: number | '', nextMaxScale = maxScale) =>
    save.mutate({
      settings: { maxScale: nextMaxScale },
      surface: 'sticker',
      entityType: 'user',
      // Keyed by the owner's own id; the service refuses any other, so this
      // cannot be pointed at someone else's account.
      entityId: currentUser.id,
      mode: nextMode as 'off' | 'review' | 'auto',
      // A creator with no row who only touches the mode has not chosen a price,
      // and writing the seeded one would freeze today's platform default into
      // their account where a later change to it would never reach them.
      price:
        !stored && nextPrice === DEFAULT_PRICE ? undefined : nextPrice === '' ? null : nextPrice,
    });

  return (
    <>
      <Divider
        label={
          <Group gap={4} wrap="nowrap">
            Stickers on your images
            <InfoPopover size="xs" iconProps={{ size: 14 }} width={320}>
              <Text size="sm" maw={300} style={{ whiteSpace: 'normal' }}>
                Let other people pay to place a sticker on your work. You keep most of what they
                pay, and you can decline anything you don&apos;t want. Individual posts and images
                can override this.
              </Text>
            </InfoPopover>
          </Group>
        }
      />

      <SegmentedControl
        value={mode}
        onChange={(value) => {
          setMode(value);
          commit(value, price);
        }}
        data={[
          { value: 'off', label: 'No stickers' },
          { value: 'review', label: 'Review each one' },
          { value: 'auto', label: 'Accept all' },
        ]}
      />

      <NumberInput
        label={
          <Group gap={4} wrap="nowrap">
            Price per placement
            <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
              <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                Your cap is {cap} Buzz, set by your creator score and membership tier. We store the
                price you choose, so if the cap rises later your price takes effect on its own.
              </Text>
            </InfoPopover>
          </Group>
        }
        leftSection={<CurrencyIcon currency={Currency.BUZZ} size={16} />}
        value={price}
        min={0}
        onChange={(value) => setPrice(typeof value === 'number' ? value : '')}
        onBlur={() => commit(mode, price)}
        maw={220}
      />

      <Stack gap={4}>
        <Group gap={4} wrap="nowrap">
          <Text size="sm" fw={500}>
            Largest sticker allowed
          </Text>
          <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
            <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
              As a share of the image&apos;s width, so it scales with however large the image is
              drawn. Placements already on your work keep the size they were accepted at.
            </Text>
          </InfoPopover>
        </Group>
        <Slider
          maw={320}
          value={maxScale}
          onChange={setMaxScale}
          onChangeEnd={(value) => commit(mode, price, value)}
          min={STICKER_PLACEMENT_MIN_SCALE}
          max={STICKER_PLACEMENT_MAX_SCALE}
          step={0.01}
          label={null}
        />
        {/* The unit carries the explanation, so the number is not a bare
            percentage of something the reader has to go and find. */}
        <Text size="sm" c="dimmed">
          <Text span fw={600} c="var(--mantine-color-text)">
            {Math.round(maxScale * 100)}%
          </Text>{' '}
          of the size of the image
        </Text>
      </Stack>

      {/* The queue is otherwise unreachable: the notification links to the image,
          and nothing else in the app points at it. */}
      <Group gap={6} wrap="nowrap">
        <Anchor component={Link} href="/user/sticker-placements" size="sm">
          <Group gap={4} wrap="nowrap">
            Review pending stickers
            <IconArrowRight size={14} />
          </Group>
        </Anchor>
        {waiting > 0 && (
          <Badge size="sm" color="yellow" variant="light">
            {waiting}
          </Badge>
        )}
      </Group>

      {overCap && (
        <Alert color="yellow" p="xs">
          <Text size="xs">
            You&apos;ll be charging {cap} Buzz — your current cap — until your score or membership
            raises it.
          </Text>
        </Alert>
      )}

      {mode !== 'off' && price === '' && DEFAULT_PRICE == null && (
        <Alert color="red" p="xs">
          <Text size="xs">Set a price before opening your space, or nobody can place.</Text>
        </Alert>
      )}

      {!stored && (
        <Alert color="blue" p="xs">
          <Text size="xs">
            This is the default and it is already in effect — people can place stickers on your
            images for {DEFAULT_PRICE} Buzz, and you review each one. Change anything here to make
            it yours.
          </Text>
        </Alert>
      )}
    </>
  );
}
