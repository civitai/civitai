import { Anchor, Button, Group, Modal, NumberInput, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import { useState } from 'react';
import { sanitizeAppChromeName } from '~/components/AppBlocks/appChromeName';
import { useConfirmArmDelay } from '~/components/AppBlocks/GuardedConfirmDialog';
import { useDialogContext, useDialogId } from '~/components/Dialog/DialogProvider';
import { useIsTopDialog } from '~/components/Dialog/dialogStore';
import {
  APP_DAILY_LIMIT_SETTINGS_PATH,
  BLOCK_CONSENT_BUDGET_MAX_PER_DAY,
} from '~/shared/constants/block-scope.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export type DailyLimitRaiseDialogProps = {
  appBlockId: string;
  appName?: string | null;
  limit: number;
  spentToday: number;
  /** Called once the server has confirmed the raise, before the dialog closes. */
  onRaised?: () => void;
};

export function defaultRaisedLimit(limit: number): number {
  return Math.min(limit * 2, BLOCK_CONSENT_BUDGET_MAX_PER_DAY);
}

/**
 * The host's own dialog for raising the viewer's daily Buzz limit for one app, drawn outside the
 * iframe. The app never supplies the number: the viewer types it, and "Raise limit" stays
 * disabled for the arm delay (and while another dialog is on top) so a click aimed at the app
 * cannot land on it. Focus starts on "Not now".
 */
export default function DailyLimitRaiseDialog({
  appBlockId,
  appName,
  limit,
  spentToday,
  onRaised,
}: DailyLimitRaiseDialogProps) {
  const dialog = useDialogContext();
  const isTopMost = useIsTopDialog(useDialogId());
  const armed = useConfirmArmDelay(undefined, isTopMost);
  const utils = trpc.useUtils();
  const [value, setValue] = useState<number | string>(defaultRaisedLimit(limit));
  const [error, setError] = useState<string | null>(null);
  const who = sanitizeAppChromeName(appName) ?? 'this app';

  const mutation = trpc.blocks.raiseAppDailyLimit.useMutation({
    onSuccess: async () => {
      onRaised?.();
      await utils.blocks.getMyAppDailyLimit.invalidate({ appBlockId });
      await utils.blocks.listMyScopeGrants.invalidate();
      dialog.onClose();
    },
    onError: (e) => setError(e.message),
  });

  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  const valid =
    Number.isInteger(parsed) && parsed > limit && parsed <= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;
  const atMax = limit >= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;

  return (
    <Modal {...dialog} title={`Daily Buzz limit for ${who}`}>
      <Stack gap="sm" data-testid="block-daily-limit-raise">
        <Text size="sm">
          You set a limit of {numberWithCommas(limit)} Buzz a day for {who}, and{' '}
          {numberWithCommas(spentToday)} has been spent today. Nothing was charged for the job that
          was stopped.
        </Text>
        {atMax ? (
          <Text size="sm" c="dimmed">
            This is already the highest daily limit an app can have.
          </Text>
        ) : (
          <NumberInput
            label="New daily limit (Buzz)"
            value={value}
            onChange={setValue}
            min={limit + 1}
            max={BLOCK_CONSENT_BUDGET_MAX_PER_DAY}
            step={100}
            thousandSeparator=","
            allowDecimal={false}
            allowNegative={false}
            error={
              value !== '' && !valid
                ? `Enter more than ${numberWithCommas(limit)} and at most ${numberWithCommas(
                    BLOCK_CONSENT_BUDGET_MAX_PER_DAY
                  )}`
                : undefined
            }
            data-testid="block-daily-limit-raise-input"
          />
        )}
        {error && (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
        <Anchor component={Link} href={APP_DAILY_LIMIT_SETTINGS_PATH} size="sm">
          Manage limits
        </Anchor>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => dialog.onClose()} data-autofocus>
            Not now
          </Button>
          {!atMax && (
            <Button
              disabled={!armed || !valid}
              loading={mutation.isPending}
              onClick={() => {
                setError(null);
                mutation.mutate({ appBlockId, buzzBudgetPerDay: parsed });
              }}
              data-testid="block-daily-limit-raise-confirm"
            >
              Raise limit
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
