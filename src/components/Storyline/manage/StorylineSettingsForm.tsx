import { Anchor, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import { StorylinePriceInput } from '~/components/Storyline/settings/StorylinePriceInput';
import { StorylineRatingInput } from '~/components/Storyline/settings/StorylineRatingInput';
import type { StorylineContinueMode } from '~/components/Storyline/storyline-ui';

export type StorylineStatusValue = 'Ongoing' | 'Complete';

/** The storyline's placement space as its owner reads it. */
export type StorylineSpaceSettings = {
  mode: StorylineContinueMode;
  /** The price stored on this storyline; `null` follows the creator's default. */
  setPrice: number | null;
  /** What a contributor is charged now, after inheritance and the cap. */
  price: number;
  cap: number;
};

export function StorylineSettingsForm({
  status,
  maxNsfwLevel,
  space,
  onStatusChange,
  onRatingChange,
  onSpaceChange,
  disabled,
}: {
  status: StorylineStatusValue;
  maxNsfwLevel: number;
  /** `null` while loading, or where the space cannot be read. */
  space: StorylineSpaceSettings | null;
  onStatusChange: (status: StorylineStatusValue) => void;
  onRatingChange: (level: number) => void;
  onSpaceChange: (next: { mode: StorylineContinueMode; price: number | null }) => void;
  disabled?: boolean;
}) {
  // Local so the thumb follows the drag; the write happens on release.
  const [price, setPrice] = useState<number | ''>(space?.setPrice ?? '');
  useEffect(() => setPrice(space?.setPrice ?? ''), [space?.setPrice]);

  const complete = status === 'Complete';

  return (
    <Stack gap="lg">
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Status
        </Text>
        <SegmentedControl
          aria-label="Status"
          fullWidth
          disabled={disabled}
          value={status}
          onChange={(value) => onStatusChange(value as StorylineStatusValue)}
          data={[
            { value: 'Ongoing', label: 'Ongoing' },
            { value: 'Complete', label: 'Complete' },
          ]}
        />
        <Text size="xs" c="dimmed">
          Complete closes the storyline to new continuations.
        </Text>
      </Stack>

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Who can continue
        </Text>
        <StorylineContinueModeInput
          value={space?.mode ?? 'review'}
          disabled={disabled || !space || complete}
          onChange={(mode) => space && onSpaceChange({ mode, price: space.setPrice })}
        />
        <Text size="xs" c="dimmed">
          {complete
            ? 'Set the storyline back to Ongoing to accept continuations again.'
            : 'Endorsed collaborators skip review either way.'}
        </Text>
      </Stack>

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Maximum rating
        </Text>
        <StorylineRatingInput value={maxNsfwLevel} disabled={disabled} onChange={onRatingChange} />
        <Text size="xs" c="dimmed">
          Higher-rated continuations cannot be submitted or shown. Readers also keep their own
          browsing settings.
        </Text>
      </Stack>

      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm" fw={500}>
            Price to continue
          </Text>
          {space && space.setPrice != null && (
            <Anchor
              component="button"
              type="button"
              size="xs"
              disabled={disabled}
              onClick={() => onSpaceChange({ mode: space.mode, price: null })}
            >
              Use my default
            </Anchor>
          )}
        </Group>
        <StorylinePriceInput
          value={price}
          fallback={space?.price ?? 0}
          cap={space?.cap ?? null}
          disabled={disabled || !space}
          onChange={setPrice}
          onCommit={(value) => {
            setPrice(value);
            if (space) onSpaceChange({ mode: space.mode, price: value });
          }}
        />
        <Text size="xs" c="dimmed">
          {(space?.price ?? 0) > 0
            ? 'Contributors pay when they submit. Accept and you keep it; decline and they are refunded minus a small fee; if it expires they are refunded in full.'
            : 'Anyone can submit. You still review each one, and the rating limit still applies.'}
        </Text>
      </Stack>
    </Stack>
  );
}
