import { Anchor, Button, Code, Group, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import type {
  ConfirmedStepConsentCopy,
  ConfirmedStepDailyLimitCopy,
  ConfirmedStepQuotePreview,
} from '~/components/AppBlocks/runConfirmedStepGate';
import { APP_DAILY_LIMIT_SETTINGS_PATH } from '~/shared/constants/block-scope.constants';

/**
 * The BODY of the `RUN_CONFIRMED_STEP` host-chrome consent dialog.
 *
 * Every value comes from `copy` / `preview`, both derived from the SERVER'S preview of
 * the stored quote — there is no prop a block can set. `onBuyBuzz` is offered only when
 * the server reports a shortfall; it opens the existing Buy-Buzz modal and does not
 * close this dialog.
 */
export function ConfirmedStepConsentBody({
  copy,
  preview,
  onBuyBuzz,
}: {
  copy: ConfirmedStepConsentCopy;
  preview: ConfirmedStepQuotePreview;
  onBuyBuzz?: () => void;
}) {
  return (
    <Stack gap="sm" data-testid="block-confirmed-step-consent">
      <Text size="sm">{copy.intro}</Text>
      <Text size="sm" c="dimmed">
        Job type: <Code>{preview.stepType}</Code>
      </Text>

      <Text size="sm" fw={600} data-testid="block-confirmed-step-price">
        {copy.priceLine}
      </Text>

      {copy.dailyLimitLine && (
        <Text size="sm" data-testid="block-confirmed-step-daily-limit">
          {copy.dailyLimitLine}
        </Text>
      )}

      {copy.shortfallLine && (
        <Group gap="xs" justify="space-between" data-testid="block-confirmed-step-shortfall">
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

/**
 * The BODY of the daily-limit REFUSAL dialog — shown instead of a confirm. It names
 * the limit, says nothing was charged, and links to where the viewer can raise it.
 */
export function ConfirmedStepDailyLimitBody({
  copy,
  onClose,
}: {
  copy: ConfirmedStepDailyLimitCopy;
  onClose: () => void;
}) {
  return (
    <Stack gap="sm" data-testid="block-confirmed-step-daily-limit-refusal">
      <Text size="sm">{copy.body}</Text>
      <Anchor component={Link} href={APP_DAILY_LIMIT_SETTINGS_PATH} size="sm">
        {copy.linkLabel}
      </Anchor>
      <Button onClick={onClose}>Close</Button>
    </Stack>
  );
}

/** The BODY of a plain host notice about a confirmed step (e.g. an unconfirmed outcome). */
export function ConfirmedStepNoticeBody({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <Stack gap="sm" data-testid="block-confirmed-step-notice">
      <Text size="sm">{text}</Text>
      <Button onClick={onClose}>Close</Button>
    </Stack>
  );
}
