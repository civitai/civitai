import { SegmentedControl } from '@mantine/core';
import { STORYLINE_RATING_OPTIONS } from '~/components/Storyline/storyline-ui';

/** The highest rating a storyline accepts. One level, not a mask: it is a ceiling. */
export function StorylineRatingInput({
  value,
  onChange,
  disabled,
  isAllowed,
}: {
  value: number;
  onChange: (level: number) => void;
  disabled?: boolean;
  /** Ratings that may not be chosen, e.g. below a chapter already in the storyline. */
  isAllowed?: (level: number) => boolean;
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
        disabled: isAllowed ? !isAllowed(option.value) : false,
      }))}
    />
  );
}
