import {
  Alert,
  Card,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Account-level control over who may place stickers on this creator's images,
 * and what it costs them.
 *
 * The price the creator sets is what gets stored; the cap is computed at read
 * from their score and membership tier, so a lapse or a score change moves it
 * immediately. That is why the cap is shown as live copy rather than used to
 * clamp the input — clamping here would make the stored number silently
 * disagree with what they typed the moment their tier changed.
 */
export function PlacementSpaceCard() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const { data: range } = trpc.placement.getPriceRange.useQuery(
    { surface: 'sticker' },
    { enabled: !!features.stickerPlacement }
  );
  const { data: spaces } = trpc.placement.getMySpaces.useQuery(
    { surface: 'sticker' },
    { enabled: !!features.stickerPlacement }
  );

  const stored = spaces?.[0];
  const [mode, setMode] = useState('off');
  const [price, setPrice] = useState<number | ''>('');

  useEffect(() => {
    if (!stored) return;
    setMode(stored.mode);
    setPrice(stored.price ?? '');
  }, [stored]);

  const save = trpc.placement.setSpace.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Sticker placement settings saved.' });
      await utils.placement.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: "Couldn't save that", error: new Error(error.message) }),
  });

  if (!features.stickerPlacement || !currentUser) return null;

  const cap = range?.max ?? 0;
  const overCap = typeof price === 'number' && cap > 0 && price > cap;

  const commit = (nextMode: string, nextPrice: number | '') => {
    if (!currentUser) return;
    save.mutate({
      surface: 'sticker',
      entityType: 'user',
      // The account-level space is keyed by the owner's own id; the service
      // refuses any other, so this cannot be pointed at someone else's account.
      entityId: currentUser.id,
      mode: nextMode as 'off' | 'review' | 'auto',
      price: nextPrice === '' ? null : nextPrice,
    });
  };

  return (
    <Card withBorder>
      <Stack gap="sm">
        <Title order={4}>Stickers on your images</Title>
        <Text size="sm" c="dimmed">
          Let other people pay to place a sticker on your work. You keep most of what they pay, and
          you can decline anything you don&apos;t want. Individual posts and images can override
          this.
        </Text>

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

        <Group align="end" gap="sm">
          <NumberInput
            label="Price per placement"
            description={
              cap > 0
                ? `Your cap is ${cap} Buzz, based on your creator score and membership.`
                : 'Set a price before opening your space.'
            }
            value={price}
            min={0}
            onChange={(value) => setPrice(typeof value === 'number' ? value : '')}
            onBlur={() => commit(mode, price)}
            w={280}
          />
        </Group>

        {overCap && (
          <Alert color="yellow" p="xs">
            <Text size="xs">
              You&apos;ll be charging {cap} Buzz — your current cap — until your score or membership
              raises it. We keep the price you set, so it takes effect on its own.
            </Text>
          </Alert>
        )}

        {mode !== 'off' && price === '' && (
          <Alert color="red" p="xs">
            <Text size="xs">Set a price before opening your space, or nobody can place.</Text>
          </Alert>
        )}
      </Stack>
    </Card>
  );
}
