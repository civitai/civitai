import { SegmentedControl } from '@mantine/core';
import {
  isStorylineContinueMode,
  STORYLINE_CONTINUE_MODES,
  type StorylineContinueMode,
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
  value: StorylineContinueMode;
  onChange: (mode: StorylineContinueMode) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl
      aria-label="Who can continue"
      fullWidth
      disabled={disabled}
      value={value}
      onChange={(next) => isStorylineContinueMode(next) && onChange(next)}
      data={STORYLINE_CONTINUE_MODES.map((mode) => ({ value: mode.value, label: mode.label }))}
    />
  );
}
