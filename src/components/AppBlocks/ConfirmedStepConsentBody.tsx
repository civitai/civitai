import { Anchor, Button, Checkbox, Code, Group, NumberInput, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import { useState } from 'react';
import {
  confirmedStepStandingLimitHint,
  type ConfirmedStepConsentCopy,
  type ConfirmedStepDailyLimitCopy,
  type ConfirmedStepQuotePreview,
  type ConfirmedStepStandingOfferCopy,
} from '~/components/AppBlocks/runConfirmedStepGate';
import {
  APP_DAILY_LIMIT_SETTINGS_PATH,
  BLOCK_CONSENT_BUDGET_MAX_PER_DAY,
} from '~/shared/constants/block-scope.constants';

/**
 * What the viewer chose in the opt-in, read by the confirm handler when they press Run.
 * `limit` is set only for the new-limit offer, and only to a valid value.
 */
export type ConfirmedStepStandingChoice = { checked: boolean; limit?: number };

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
  standingOffer,
  onStandingChange,
}: {
  copy: ConfirmedStepConsentCopy;
  preview: ConfirmedStepQuotePreview;
  onBuyBuzz?: () => void;
  standingOffer?: ConfirmedStepStandingOfferCopy | null;
  onStandingChange?: (choice: ConfirmedStepStandingChoice) => void;
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

      {copy.fundingLine && (
        <Text size="sm" data-testid="block-confirmed-step-funding">
          {copy.fundingLine}
        </Text>
      )}

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

      {standingOffer && onStandingChange && (
        <StandingOffer offer={standingOffer} onChange={onStandingChange} />
      )}
    </Stack>
  );
}

function StandingOffer({
  offer,
  onChange,
}: {
  offer: ConfirmedStepStandingOfferCopy;
  onChange: (choice: ConfirmedStepStandingChoice) => void;
}) {
  const [checked, setChecked] = useState(false);
  const [limit, setLimit] = useState<number | string>(
    offer.kind === 'new-limit' ? offer.suggestedLimit : 0
  );
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  const valid =
    offer.kind === 'new-limit' &&
    Number.isInteger(parsed) &&
    parsed >= offer.minLimit &&
    parsed <= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;
  const report = (nextChecked: boolean, nextLimit: number | string) => {
    if (offer.kind === 'existing-limit') return onChange({ checked: nextChecked });
    const n = typeof nextLimit === 'number' ? nextLimit : Number(nextLimit);
    const ok = Number.isInteger(n) && n >= offer.minLimit && n <= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;
    onChange({ checked: nextChecked && ok, limit: ok ? n : undefined });
  };
  return (
    <Stack gap={4} data-testid="block-confirmed-step-standing-offer">
      <Checkbox
        size="sm"
        label={offer.label}
        checked={checked}
        onChange={(e) => {
          setChecked(e.currentTarget.checked);
          report(e.currentTarget.checked, limit);
        }}
        data-testid="block-confirmed-step-standing-checkbox"
      />
      {offer.kind === 'new-limit' && checked && (
        <NumberInput
          size="xs"
          label="Daily limit (Buzz)"
          value={limit}
          min={offer.minLimit}
          max={BLOCK_CONSENT_BUDGET_MAX_PER_DAY}
          allowDecimal={false}
          thousandSeparator=","
          onChange={(v) => {
            setLimit(v);
            report(checked, v);
          }}
          description={valid ? confirmedStepStandingLimitHint(parsed) : undefined}
          error={valid ? undefined : `Enter at least ${offer.minLimit.toLocaleString('en-US')}`}
          data-testid="block-confirmed-step-standing-limit"
        />
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
