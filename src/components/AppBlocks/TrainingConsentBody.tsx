import { Button, Group, Stack, Text } from '@mantine/core';
import type {
  TrainingConsentCopy,
  TrainingQuotePreview,
} from '~/components/AppBlocks/runTrainingGate';

/**
 * The BODY of the `RUN_TRAINING` host-chrome consent dialog.
 *
 * Every value comes from `copy` / `preview`, both derived from the SERVER'S
 * preview of the stored quote — there is no prop a block can set. The thumbnails
 * are the dataset the run trains on, so the viewer can see whose images these are.
 *
 * `onBuyBuzz` is offered only when the server reports a shortfall; it opens the
 * existing Buy-Buzz modal and does not close this dialog.
 */
export function TrainingConsentBody({
  copy,
  preview,
  onBuyBuzz,
}: {
  copy: TrainingConsentCopy;
  preview: TrainingQuotePreview;
  onBuyBuzz?: () => void;
}) {
  return (
    <Stack gap="sm" data-testid="block-training-consent">
      <Text size="sm">{copy.intro}</Text>

      {preview.thumbnails.length > 0 && (
        <Group gap="xs" wrap="wrap" data-testid="block-training-thumbs">
          {preview.thumbnails.map((url, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${url}-${i}`}
              src={url}
              alt={`Training image ${i + 1} of ${preview.imageCount}`}
              width={64}
              height={64}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
          ))}
        </Group>
      )}

      <Stack gap={2} data-testid="block-training-details">
        {copy.details.map((line) => (
          <Text key={line} size="sm">
            {line}
          </Text>
        ))}
      </Stack>

      <Text size="sm" fw={600} data-testid="block-training-price">
        {copy.priceLine}
      </Text>

      {copy.shortfallLine && (
        <Group gap="xs" justify="space-between" data-testid="block-training-shortfall">
          <Text size="sm" c="red">
            {copy.shortfallLine}
          </Text>
          {onBuyBuzz && (
            <Button size="compact-sm" variant="light" onClick={onBuyBuzz}>
              Get Buzz
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}
