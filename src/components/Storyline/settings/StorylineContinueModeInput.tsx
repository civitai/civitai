import { SegmentedControl } from '@mantine/core';
import {
  isStorylineWhoCanContinue,
  STORYLINE_WHO_CAN_CONTINUE,
  type StorylineWhoCanContinue,
} from '~/components/Storyline/storyline-ui';

/**
 * Who may continue a storyline. There is no "open, no review" option: a continuation adds
 * someone else's media after your chapter, so every one passes the creator unless they endorsed
 * its author.
 */
export function StorylineContinueModeInput({
  value,
  onChange,
  disabled,
}: {
  value: StorylineWhoCanContinue;
  onChange: (value: StorylineWhoCanContinue) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      aria-label="Who can continue"
      fullWidth
      disabled={disabled}
      value={value}
      onChange={(next) => isStorylineWhoCanContinue(next) && onChange(next)}
      data={STORYLINE_WHO_CAN_CONTINUE.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
    />
  );
}
