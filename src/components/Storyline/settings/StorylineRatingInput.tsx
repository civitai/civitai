import { SegmentedControl } from '@mantine/core';
import { STORYLINE_RATING_OPTIONS } from '~/components/Storyline/storyline-ui';

/** The highest rating a storyline accepts. One level, not a mask: it is a ceiling. */
export function StorylineRatingInput({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (level: number) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      aria-label="Maximum rating"
      fullWidth
      disabled={disabled}
      value={String(value)}
      onChange={(next) => onChange(Number(next))}
      data={STORYLINE_RATING_OPTIONS.map((option) => ({
        value: String(option.value),
        label: option.label,
      }))}
    />
  );
}
