import { Anchor, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconBolt, IconCircleCheck, IconShieldHalf, IconUsers } from '@tabler/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import { StorylinePriceInput } from '~/components/Storyline/settings/StorylinePriceInput';
import { StorylineRatingInput } from '~/components/Storyline/settings/StorylineRatingInput';
import {
  storylineCeilingImpact,
  type StorylineChapterLevels,
  type StorylineWhoCanContinue,
} from '~/components/Storyline/storyline-ui';

export type StorylineStatusValue = 'Ongoing' | 'Complete';

/** The storyline's placement space as its owner reads it. */
export type StorylineSpaceSettings = {
  /** The price stored on this storyline; `null` follows the creator's default. */
  setPrice: number | null;
  /** What a contributor is charged now, after inheritance and the cap. */
  price: number;
  cap: number;
};

export function StorylineSettingsForm({
  status,
  maxNsfwLevel,
  whoCanContinue,
  space,
  chapterLevels,
  onStatusChange,
  onRatingChange,
  onWhoCanContinueChange,
  onPriceChange,
  priceUnavailable,
  coverRow,
  disabled,
}: {
  status: StorylineStatusValue;
  maxNsfwLevel: number;
  /** `null` where the storyline does not report it yet. */
  whoCanContinue: StorylineWhoCanContinue | null;
  /** `null` while loading, or where the space cannot be read. */
  space: StorylineSpaceSettings | null;
  /** `null` while loading; the picker then offers every rating and says nothing about chapters. */
  chapterLevels?: StorylineChapterLevels | null;
  onStatusChange: (status: StorylineStatusValue) => void;
  onRatingChange: (level: number) => void;
  onWhoCanContinueChange: (value: StorylineWhoCanContinue) => void;
  /** `null` returns the storyline to the creator's default price. */
  onPriceChange: (price: number | null) => void;
  /** The space read refuses this storyline for now: no slider, only a note. */
  priceUnavailable?: boolean;
  coverRow?: ReactNode;
  disabled?: boolean;
}) {
  // Local so the thumb follows the drag; the write happens on release.
  const [price, setPrice] = useState<number | ''>(space?.setPrice ?? '');
  useEffect(() => setPrice(space?.setPrice ?? ''), [space?.setPrice]);

  const complete = status === 'Complete';
  const hidden = chapterLevels ? storylineCeilingImpact(maxNsfwLevel, chapterLevels).hidden : 0;

  return (
    <div className="divide-y divide-gray-2 overflow-hidden rounded-xl border border-gray-3 bg-gray-0 shadow-sm dark:divide-dark-5 dark:border-dark-4 dark:bg-dark-6">
      {coverRow && <div className="px-4 py-3">{coverRow}</div>}

      <SettingsRow icon={<IconCircleCheck size={16} />} label="Status">
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
      </SettingsRow>

      <SettingsRow icon={<IconUsers size={16} />} label="Who can continue">
        <StorylineContinueModeInput
          value={whoCanContinue ?? 'Anyone'}
          disabled={disabled || !whoCanContinue || complete}
          onChange={onWhoCanContinueChange}
        />
        <Text size="xs" c="dimmed">
          {complete
            ? 'Set the storyline back to Ongoing to accept continuations again.'
            : 'Endorsed collaborators skip review either way.'}
        </Text>
      </SettingsRow>

      <SettingsRow icon={<IconShieldHalf size={16} />} label="Maximum rating">
        <StorylineRatingInput
          value={maxNsfwLevel}
          disabled={disabled}
          onChange={onRatingChange}
          isAllowed={
            chapterLevels
              ? (level) => storylineCeilingImpact(level, chapterLevels).allowed
              : undefined
          }
        />
        {hidden > 0 && (
          <Text size="xs" c="yellow">
            {hidden === 1
              ? '1 chapter is rated above this and is hidden from readers.'
              : `${hidden} chapters are rated above this and are hidden from readers.`}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Higher-rated continuations cannot be submitted, and chapters rated above this are hidden
          from readers. Raising it again brings them back. Readers also keep their own browsing
          settings.
        </Text>
      </SettingsRow>

      <SettingsRow
        icon={<IconBolt size={16} />}
        label="Price to continue"
        action={
          !priceUnavailable &&
          space &&
          space.setPrice != null &&
          !complete && (
            <Anchor
              component="button"
              type="button"
              size="xs"
              disabled={disabled}
              onClick={() => onPriceChange(null)}
            >
              Use my default
            </Anchor>
          )
        }
      >
        {priceUnavailable ? (
          // Says nothing about the price itself: the stored one may not be free.
          <Text size="xs" c="dimmed">
            The price is not available yet.
          </Text>
        ) : (
          <>
            {/* Inset: the slider's end labels hang past its track and would cross the card edge. */}
            <div className="px-3">
              <StorylinePriceInput
                value={price}
                fallback={space?.price ?? 0}
                cap={space?.cap ?? null}
                disabled={disabled || !space || complete}
                onChange={setPrice}
                onCommit={(value) => {
                  setPrice(value);
                  onPriceChange(value);
                }}
              />
            </div>
            <Text size="xs" c="dimmed">
              {(space?.price ?? 0) > 0
                ? 'Contributors pay when they submit. Accept and you keep it; decline and they are refunded minus a small fee; if it expires they are refunded in full.'
                : 'Anyone can submit. You still review each one, and the rating limit still applies.'}
            </Text>
          </>
        )}
      </SettingsRow>
    </div>
  );
}

function SettingsRow({
  icon,
  label,
  action,
  children,
}: {
  icon: ReactNode;
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack gap={6} className="px-4 py-3">
      <Group justify="space-between" gap="xs" wrap="nowrap">
        <Group gap={6} wrap="nowrap" className="text-gray-7 dark:text-dark-1">
          {icon}
          <Text size="sm" fw={500}>
            {label}
          </Text>
        </Group>
        {action}
      </Group>
      {children}
    </Stack>
  );
}
