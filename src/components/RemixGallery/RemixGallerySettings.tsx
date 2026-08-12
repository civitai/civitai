import { Alert, Anchor, Divider, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { PLACEMENT_MIN_PRICE, PLACEMENT_SURFACES } from '~/shared/utils/placement';
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

  const stored = spaces?.[0];
  const [mode, setMode] = useState('off');
  const [price, setPrice] = useState<number | ''>('');
  const [contentRule, setContentRule] = useState<RemixGalleryContentRule>('atOrBelow');

  useEffect(() => {
    if (!stored) return;
    setMode(stored.mode);
    setPrice(stored.price ?? '');
    setContentRule(remixGalleryContentRule(stored.settings as Record<string, unknown>));
  }, [stored]);

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: () => utils.placement.invalidate(),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) }),
  });

  if (!enabled || !currentUser) return null;

  const cap = range?.max ?? 0;
  const overCap = typeof price === 'number' && cap > 0 && price > cap;

  const commit = (
    nextMode: string,
    nextPrice: number | '',
    nextRule: RemixGalleryContentRule = contentRule
  ) =>
    save.mutate({
      settings: { contentRule: nextRule },
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
        <Text size="xs" c="dimmed">
          {price === ''
            ? `Submitters pay ${PLACEMENT_SURFACES.remixGallery.defaultPrice} Buzz, the default, until you set your own.`
            : `Submitters pay ${price} Buzz.`}
        </Text>
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

      <Group gap={6} wrap="nowrap">
        <Anchor component={Link} href="/user/remix-submissions" size="sm">
          <Group gap={4} wrap="nowrap">
            Remixes you&apos;ve submitted elsewhere
            <IconArrowRight size={14} />
          </Group>
        </Anchor>
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
