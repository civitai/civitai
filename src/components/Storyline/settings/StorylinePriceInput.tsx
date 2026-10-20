import { Stack, Text } from '@mantine/core';
import { PlacementPriceSlider } from '~/components/Placement/PlacementPriceSlider';
import { storylinePriceCaption } from '~/components/Storyline/storyline-ui';

/**
 * `''` means no price of its own, so the storyline follows the creator's default; `fallback` is
 * that inherited price, which is where the thumb rests.
 */
export function StorylinePriceInput({
  value,
  fallback = 0,
  cap,
  onChange,
  onCommit,
  disabled,
}: {
  value: number | '';
  fallback?: number;
  /** `null` while the creator's cap is loading. */
  cap: number | null;
  onChange: (price: number) => void;
  onCommit: (price: number) => void;
  disabled?: boolean;
}) {
  const caption = storylinePriceCaption(value === '' ? fallback : value, cap);

  return (
    <Stack gap={4}>
      <PlacementPriceSlider
        surface="storyline"
        cap={cap}
        value={value}
        fallback={fallback}
        onChange={onChange}
        onCommit={onCommit}
        disabled={disabled}
      />
      {/* On the slider's mark row, between the end labels: keep it one short line. */}
      <Text size="xs" ta="center" mt={-22} c={caption.warning ? 'yellow' : 'dimmed'}>
        {caption.text}
      </Text>
    </Stack>
  );
}
