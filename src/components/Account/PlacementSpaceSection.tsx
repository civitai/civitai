import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Group,
  SegmentedControl,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
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
import { QueueCountBadge } from '~/components/Placement/QueueCountBadge';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import {
  STICKER_QUEUE_RECEIVED_URL,
  STICKER_QUEUE_SENT_URL,
} from '~/components/Placement/queue-routes';
import { PlacementFreeSlotSlider } from '~/components/Placement/PlacementFreeSlotSlider';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { pendingCount } from '~/components/Placement/queue-counts';
import { placementPriceCaption, PLACEMENT_SURFACES } from '~/shared/utils/placement';
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
 * immediately.
 *
 * The slider's ceiling is that cap, so a price above it is no longer settable
 * here — but a price stored before the cap moved is left alone and disclosed
 * rather than rounded on sight, because silently rewriting it is how a creator
 * finds out from their earnings.
 */
export function PlacementSpaceSection() {
  const { pendingPlacements } = useQueryNotificationsCount();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const enabled = !!features.stickerPlacement;
  const { data: range } = trpc.placement.getPriceRange.useQuery(
    { surface: 'sticker' },
    { enabled }
  );
  const {
    data: spaces,
    isPending: spacesPending,
    isError: spacesFailed,
  } = trpc.placement.getMySpaces.useQuery({ surface: 'sticker' }, { enabled });
  // The paged `placement.getPending` query this card used to make is gone with
  // the count that needed it: it fetched 50 rows and joined every image just to
  // read `.length` for a badge, on a settings page that never renders one of
  // them.
  const { data: sent } = trpc.placement.getMyStickerPlacements.useQuery({}, { enabled });

  const stored = spaces?.[0];
  // Seeded from the surface defaults, not from `off`. With no row the cascade
  // resolves this space open, and a control that showed "No stickers" would be
  // telling a creator their space is closed on the one screen where they say so
  // — they would find out it was open from a review notification.
  const [mode, setMode] = useState<string>(DEFAULT_MODE);
  const [price, setPrice] = useState<number | ''>(DEFAULT_PRICE ?? '');
  const [maxScale, setMaxScale] = useState(STICKER_PLACEMENT_DEFAULT_MAX_SCALE);
  // `null`, not the default value, and that distinction is the mechanism rather
  // than a nicety: a stored number stops tracking the surface default when it
  // moves. Seeding this to `1` and sending it on every commit wrote an explicit
  // `1` the first time a creator touched anything else on this page, so within a
  // few weeks of normal use raising the default would have reached nobody.
  //
  // It also cannot be recovered by diffing against the default, because "unset"
  // and "deliberately set to 1" are the same number.
  const [freeSlots, setFreeSlots] = useState<number | null>(null);

  useEffect(() => {
    if (!stored) {
      setMode(DEFAULT_MODE);
      setPrice(DEFAULT_PRICE ?? '');
      setFreeSlots(null);
      return;
    }
    setMode(stored.mode);
    setPrice(stored.price ?? '');
    setFreeSlots(stored.freeSlots);
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
      // Same expression the load effect uses. A row with a null price is
      // ordinary, and rolling it back to the platform default would leave the
      // page asserting a price the creator never chose — which the next commit
      // would then write into their row.
      setPrice(stored ? stored.price ?? '' : DEFAULT_PRICE ?? '');
      setFreeSlots(stored?.freeSlots ?? null);
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) });
    },
  });

  if (!enabled || !currentUser) return null;
  // `spaces` is undefined in every terminal state except success — in flight
  // AND after the retries are exhausted — and undefined is indistinguishable
  // from "no row". Rendering against either would seed the defaults and let one
  // click write `review` over a space the creator had explicitly closed. A
  // failed read is not permission to assume they have no preference.
  if (spacesPending || spacesFailed) return null;

  const cap = range?.max ?? 0;
  const freeSlotCap = range?.freeSlotCap ?? 0;
  // The real count, not this page's `items.length`. That was one page's worth —
  // a floor badged with a `+`, which told an owner with 200 waiting that they
  // had "50+". It rides on `checkNotifications`, already in flight for the
  // notification bell, so this costs no request; and it is now the SAME number
  // the user menu shows, where before this card and the menu answered "how many
  // are waiting on me" differently.
  const waiting = pendingPlacements;

  const placedCount = pendingCount(sent ?? []);
  const caption = placementPriceCaption(
    'sticker',
    price === '' ? DEFAULT_PRICE ?? 0 : price,
    range?.max ?? null
  );

  const commit = (
    nextMode: string,
    nextPrice: number | '',
    nextMaxScale = maxScale,
    /**
     * Sent ONLY when the free-slot control was the thing that moved. `undefined`
     * leaves the stored value alone, which for a creator who has never touched
     * it means leaving it NULL — and NULL is what tracks the surface default.
     * Sending the on-screen number on every commit is what froze it.
     */
    nextFreeSlots?: number
  ) =>
    save.mutate({
      settings: { maxScale: nextMaxScale },
      freeSlots: nextFreeSlots,
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

      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            <Text size="sm" fw={500}>
              Price per placement
            </Text>
            <CurrencyIcon currency={Currency.BUZZ} size={16} />
            <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
              <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                Your cap is {cap} Buzz, set by your creator score and membership tier. We store the
                price you choose, so if the cap rises later your price takes effect on its own.
              </Text>
            </InfoPopover>
          </Group>
          {/* The slider only emits numbers, so without this a creator who touches
              it once can never get back to having no price of their own — and an
              unset price is not the same as a stored 100: it follows the platform
              default when that changes, where a stored one freezes today's. */}
          {price !== '' && (
            <Anchor component="button" type="button" size="xs" onClick={() => commit(mode, '')}>
              Use the platform default
            </Anchor>
          )}
        </Group>
        <PlacementPriceSlider
          surface="sticker"
          cap={range?.max ?? null}
          value={price}
          fallback={DEFAULT_PRICE ?? 0}
          onChange={setPrice}
          onCommit={(value) => {
            setPrice(value);
            commit(mode, value);
          }}
        />
        {/* On the marks' row, which only holds while the caption is one short
            line — see `placementPriceCaption`, which is bounded to the amount. */}
        {caption && (
          <Text size="xs" ta="center" mt={-22} c={caption.warning ? 'yellow' : 'dimmed'}>
            {caption.text}
          </Text>
        )}
      </Stack>

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

      {/* Hidden entirely at a cap of 0 rather than shown disabled: a control whose
          every position means the same thing is asking a question with one
          answer, and the cap moves on its own as a score or a membership does. */}
      {freeSlotCap > 0 && mode !== 'off' && (
        <PlacementFreeSlotSlider
          surface="sticker"
          cap={freeSlotCap}
          value={freeSlots}
          noun={['sticker', 'stickers']}
          onChange={setFreeSlots}
          onCommit={(value) => {
            setFreeSlots(value);
            commit(mode, price, maxScale, value);
          }}
        />
      )}

      {/* No longer the only way in — the user menu carries the received queue
          and the pending notification now lands on it — but still the right
          place for both directions, next to the space controls that create the
          queue. Two buttons rather than one link, matching the remix gallery:
          each direction has a count, and a count needs somewhere to sit. */}
      {/* A real button, and `component="a"` rather than `component={Link}` —
          Mantine's polymorphic button drops its styles through the Next link,
          which is why this read as bare text. */}
      <Group gap="xs" wrap="nowrap">
        <Button
          component="a"
          href={STICKER_QUEUE_RECEIVED_URL}
          variant={waiting > 0 ? 'light' : 'default'}
          size="sm"
          rightSection={<QueueCountBadge count={waiting} />}
        >
          Review pending stickers
        </Button>
        <Button
          component="a"
          href={STICKER_QUEUE_SENT_URL}
          variant="default"
          size="sm"
          rightSection={
            placedCount > 0 ? (
              <Badge size="sm" variant="light" circle>
                {placedCount}
              </Badge>
            ) : undefined
          }
        >
          Stickers you&apos;ve placed
        </Button>
      </Group>

      {/* Gated on there being no price rather than no row: a row with a null
          price is now the ordinary result of setting a mode without touching
          the price, and the page would otherwise say nothing at all about what
          placers pay. */}
      {mode !== 'off' && price === '' && (
        <Alert color="blue" p="xs">
          <Text size="xs">
            {!stored && 'This is the default and it is already in effect. '}
            You haven&apos;t set a price, so placers pay the platform default of {
              DEFAULT_PRICE
            }{' '}
            Buzz. Set one to charge your own.
          </Text>
        </Alert>
      )}
    </>
  );
}
