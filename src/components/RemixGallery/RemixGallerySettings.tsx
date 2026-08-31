import {
  REMIX_QUEUE_RECEIVED_URL,
  REMIX_QUEUE_SENT_URL,
} from '~/components/Placement/queue-routes';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Divider,
  Group,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { PlacementFreeSlotSlider } from '~/components/Placement/PlacementFreeSlotSlider';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  placementPriceCaption,
  PLACEMENT_MIN_PRICE,
  PLACEMENT_SURFACES,
} from '~/shared/utils/placement';
import type { RemixGalleryContentRule } from '~/shared/utils/remix-gallery';
import { remixGalleryContentRule } from '~/shared/utils/remix-gallery';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Account-level control over remix galleries.
 *
 * There is no "accept all" here. A sticker comes from a moderated catalog; a
 * remix gallery accepts arbitrary user media, so every submission is reviewed.
 */
export function RemixGallerySettings() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const enabled = !!features.remixGallery;
  const { data: range } = trpc.placement.getPriceRange.useQuery(
    { surface: 'remixGallery' },
    { enabled }
  );
  const { data: spaces } = trpc.placement.getMySpaces.useQuery(
    { surface: 'remixGallery' },
    { enabled }
  );
  const { data: pending } = trpc.placement.getPendingRemixGallerySubmissions.useQuery(
    {},
    { enabled }
  );
  const { data: sent } = trpc.placement.getMyRemixGallerySubmissions.useQuery({}, { enabled });

  const stored = spaces?.[0];
  // Seeded from the surface default, not from `'off'`. A creator with no row is
  // open — that is what default-on means — and showing them "No remix gallery"
  // both lies and, because `commit` sends `mode` alongside whatever changed,
  // silently writes that opt-out the first time they touch the price or the
  // content rule. Configuring the feature would have turned it off.
  const [mode, setMode] = useState<string>(PLACEMENT_SURFACES.remixGallery.defaultMode);
  const [price, setPrice] = useState<number | ''>('');
  const [contentRule, setContentRule] = useState<RemixGalleryContentRule>('atOrBelow');
  // `null`, not the default value: a stored number stops tracking the surface
  // default when it moves, and "unset" and "deliberately set to 1" are the same
  // number, so this cannot be recovered by diffing against the default later.
  const [freeSlots, setFreeSlots] = useState<number | null>(null);

  useEffect(() => {
    if (!stored) return;
    setMode(stored.mode);
    setPrice(stored.price ?? '');
    setFreeSlots(stored.freeSlots);
    setContentRule(remixGalleryContentRule(stored.settings as Record<string, unknown>));
  }, [stored]);

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) }),
  });

  if (!enabled || !currentUser) return null;

  const cap = range?.max ?? 0;
  const freeSlotCap = range?.freeSlotCap ?? 0;
  const overCap = typeof price === 'number' && cap > 0 && price > cap;
  // Waiting on the owner, and waiting on someone else. Only the first is a
  // to-do, which is why it is the one badged in yellow.
  const receivedCount = pending?.items.length ?? 0;
  // A floor once the queue pages — see the sticker twin in PlacementSpaceSection.
  const receivedLabel = pending?.nextCursor ? `${receivedCount}+` : `${receivedCount}`;
  const sentCount = (sent ?? []).filter((row) => row.status === 'pending').length;
  const caption = placementPriceCaption(
    'remixGallery',
    price === '' ? PLACEMENT_SURFACES.remixGallery.defaultPrice ?? 0 : price,
    range?.max ?? null,
    'Submitters'
  );

  const commit = (
    nextMode: string,
    nextPrice: number | '',
    nextRule: RemixGalleryContentRule = contentRule,
    /**
     * Sent ONLY when the free-slot control was the thing that moved. `undefined`
     * leaves the stored value alone, and for a creator who has never touched it
     * that means leaving it NULL — which is what tracks the surface default.
     */
    nextFreeSlots?: number
  ) =>
    save.mutate({
      settings: { contentRule: nextRule },
      freeSlots: nextFreeSlots,
      surface: 'remixGallery',
      entityType: 'user',
      entityId: currentUser.id,
      mode: nextMode as 'off' | 'review',
      price: nextPrice === '' ? null : nextPrice,
    });

  return (
    <>
      <Divider
        label={
          <Group gap={4} wrap="nowrap">
            Remix galleries on your images
            <InfoPopover size="xs" iconProps={{ size: 14 }} width={340}>
              <Text size="sm" maw={320} style={{ whiteSpace: 'normal' }}>
                Let other people pay to feature their remixes on your work. You review every
                submission and decide what a remix means on your own images. Turning this on does
                not share your prompt — hidden prompts stay hidden.
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
          { value: 'off', label: 'No remix gallery' },
          { value: 'review', label: 'Review each one' },
        ]}
      />

      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            <Text size="sm" fw={500}>
              Price per submission
            </Text>
            <InfoPopover size="xs" iconProps={{ size: 14 }} width={300}>
              <Text size="sm" maw={280} style={{ whiteSpace: 'normal' }}>
                Your cap is {cap} Buzz, set by your creator score and membership tier. We store the
                price you choose, so if the cap rises later your price takes effect on its own.
              </Text>
            </InfoPopover>
          </Group>
          {/* The slider only emits numbers, so without this a creator who touches
              it once can never get back to having no price of their own — and an
              unset price is not a stored one: it follows the platform default
              when that moves, where a stored value freezes today's. */}
          {price !== '' && (
            <Anchor component="button" type="button" size="xs" onClick={() => commit(mode, '')}>
              Use the platform default
            </Anchor>
          )}
        </Group>
        {/* The shared control, so the two surfaces cannot drift on what the
            track means. It renders no caption — each site says something
            different about a price it cannot show — so the copy below is ours. */}
        <PlacementPriceSlider
          surface="remixGallery"
          cap={range?.max ?? null}
          value={price}
          fallback={PLACEMENT_SURFACES.remixGallery.defaultPrice ?? PLACEMENT_MIN_PRICE}
          onChange={setPrice}
          onCommit={(value) => {
            setPrice(value);
            commit(mode, value);
          }}
        />
        {/* Sits on the track's mark row rather than under it, so the price costs
            no vertical space of its own. That only works while the caption is
            one short line — the marks are pinned left and right and this is
            centred, so anything longer runs into both. `placementPriceCaption`
            is bounded to the amount for that reason; do not append to it here. */}
        {caption && (
          <Text size="xs" ta="center" mt={-22} c={caption.warning ? 'yellow' : 'dimmed'}>
            {caption.text}
          </Text>
        )}
      </Stack>

      <Stack gap={4}>
        <Group gap={4} wrap="nowrap">
          <Text size="sm" fw={500}>
            What people may submit
          </Text>
          <InfoPopover size="xs" iconProps={{ size: 14 }} width={320}>
            <Text size="sm" maw={300} style={{ whiteSpace: 'normal' }}>
              Either way you review every submission before it appears. This only decides what can
              be offered to you in the first place.
            </Text>
          </InfoPopover>
        </Group>
        <SegmentedControl
          value={contentRule}
          onChange={(value) => {
            const next = value as RemixGalleryContentRule;
            setContentRule(next);
            commit(mode, price, next);
          }}
          data={[
            { value: 'atOrBelow', label: "At or below my image's rating" },
            { value: 'any', label: 'Any rating' },
          ]}
        />
      </Stack>

      {/* Hidden at a cap of 0 rather than shown disabled — every position would
          mean the same thing — and hidden with the gallery closed, where there is
          nothing to hold a slot on. */}
      {freeSlotCap > 0 && mode !== 'off' && (
        <PlacementFreeSlotSlider
          surface="remixGallery"
          cap={freeSlotCap}
          value={freeSlots}
          noun={['submission', 'submissions']}
          onChange={setFreeSlots}
          onCommit={(value) => {
            setFreeSlots(value);
            commit(mode, price, contentRule, value);
          }}
        />
      )}

      {/* Two directions, two buttons. A gallery owner both receives submissions
          and makes them, and the counts need somewhere to live — a link with an
          arrow gives a waiting count nowhere to sit, and the received one is the
          number that needs acting on. */}
      <Group gap="xs" wrap="nowrap">
        {/* `component="a"`, not `component={Link}` — the latter is what the rest
            of this file used and it renders without Mantine's button styles at
            all. Every other button-as-link in the app uses the plain anchor. */}
        <Button
          component="a"
          href={REMIX_QUEUE_RECEIVED_URL}
          variant="light"
          size="sm"
          rightSection={
            receivedCount > 0 ? (
              <Badge
                size="sm"
                color="yellow"
                variant="filled"
                // See the remix tab badge: a disc clips the "+" off "50+".
                circle={!pending?.nextCursor}
                px={pending?.nextCursor ? 6 : undefined}
              >
                {receivedLabel}
              </Badge>
            ) : undefined
          }
        >
          Submitted to you
        </Button>
        <Button
          component="a"
          href={REMIX_QUEUE_SENT_URL}
          variant="default"
          size="sm"
          rightSection={
            sentCount > 0 ? (
              <Badge size="sm" variant="light" circle>
                {sentCount}
              </Badge>
            ) : undefined
          }
        >
          You&apos;ve submitted
        </Button>
      </Group>

      {overCap && (
        <Alert color="yellow" p="xs">
          <Text size="xs">
            You&apos;ll be charging {cap} Buzz — your current cap — until your score or membership
            raises it.
          </Text>
        </Alert>
      )}

      {/* No "set a price first" warning: the surface carries a default, so an
          unset price is a normal state rather than a broken one. Saying
          otherwise would tell a creator to fix something that is working. */}
    </>
  );
}
