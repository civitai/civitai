import { ColorSwatch, Progress, Tooltip } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import { getBankableBreakdown } from '~/shared/utils/creator-program.utils';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

export function BankableBuzzMeter({
  balance,
  bankableRemaining,
  capRemaining,
  onOpenInfo,
}: {
  balance: number;
  bankableRemaining: number;
  /** `null` when nothing can be banked at all: no active membership, or no cap. */
  capRemaining: number | null;
  onOpenInfo: () => void;
}) {
  const { bankableNow, overCap, notBankable, limitedBy } = getBankableBreakdown({
    balance,
    bankableRemaining,
    capRemaining: capRemaining ?? Infinity,
  });
  const cutover = formatDate(BANKABLE_CUTOVER, 'MMM D', true);
  const segments = [
    {
      key: 'now',
      label: capRemaining === null ? 'Bankable' : 'Bankable this month',
      value: bankableNow,
      color: 'lime.6',
      description:
        capRemaining === null ? 'Bankable with an active membership.' : 'You can bank this now.',
    },
    {
      key: 'over-cap',
      label: 'Over your cap',
      value: overCap,
      color: 'yellow.6',
      description: 'Bankable, but over what your cap allows this month. It stays bankable.',
    },
    {
      key: 'not-bankable',
      label: 'Not bankable',
      value: notBankable,
      color: 'gray.6',
      description: `Generation compensation, rewards and bought Buzz since ${cutover}. It is still yours to spend.`,
    },
  ].filter((segment) => segment.value > 0);
  const held = bankableNow + overCap + notBankable;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-gray-3 p-2 dark:border-dark-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold">Bankable Buzz</p>
        <LegacyActionIcon
          color="gray"
          variant="subtle"
          aria-label="What counts as bankable"
          onClick={onOpenInfo}
        >
          <IconInfoCircle size={14} />
        </LegacyActionIcon>
      </div>

      {held > 0 && (
        <>
          <Progress.Root size="lg" radius="xl">
            {segments.map((segment) => (
              <Tooltip
                key={segment.key}
                label={`${segment.label}: ${numberWithCommas(segment.value)}`}
                withArrow
              >
                <Progress.Section
                  value={(segment.value / held) * 100}
                  color={segment.color}
                  style={{ minWidth: 8 }}
                />
              </Tooltip>
            ))}
          </Progress.Root>
          <ul className="flex flex-col gap-0.5">
            {segments.map((segment) => (
              <Tooltip key={segment.key} label={segment.description} withArrow multiline w={220}>
                <li className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <ColorSwatch
                      color={`var(--mantine-color-${segment.color.replace('.', '-')})`}
                      size={8}
                      radius="xl"
                    />
                    {segment.label}
                  </span>
                  <span className="font-semibold tabular-nums">
                    {numberWithCommas(segment.value)}
                  </span>
                </li>
              </Tooltip>
            ))}
          </ul>
        </>
      )}

      <p className="text-xs">
        {capRemaining === null ? (
          'An active membership is required to bank Buzz.'
        ) : bankableNow > 0 ? (
          <>
            You can bank up to{' '}
            <span className="inline-flex items-center font-bold">
              <CurrencyIcon currency={Currency.BUZZ} size={12} />
              {numberWithCommas(bankableNow)}
            </span>{' '}
            this month, the lower of your bankable Buzz and what is left of your cap.
          </>
        ) : held === 0 ? (
          'You have no Yellow or Green Buzz to bank.'
        ) : limitedBy === 'cap' ? (
          'You have reached your cap for this month.'
        ) : (
          'None of your Buzz is bankable right now.'
        )}
      </p>
    </div>
  );
}
