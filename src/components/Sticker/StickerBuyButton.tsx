import { Loader, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import clsx from 'clsx';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getBuzzTypeDistribution } from '~/utils/buzz';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

/**
 * A price on a sticker tile, at tile width.
 *
 * `BuzzTransactionButton` is the right control everywhere it fits — but it lays
 * out a label and a separate amount badge side by side with a minimum gap, and
 * at ~96px the label had nowhere to go and the price wrapped. This is the same
 * transaction (same balance check, same top-up modal on a short balance) drawn
 * as one thing: a bolt and a number.
 *
 * The colour is not decoration. Which Buzz actually funds the purchase depends
 * on the domain (yellow on .com, green on .green) and on whether the seller
 * accepts Blue, so the caller passes the types the server will charge and the
 * bolt takes the colour of whichever one pays the larger share. A yellow bolt
 * on a purchase that spends Blue would be telling the buyer the wrong thing
 * about their own balance.
 */
export function StickerBuyButton({
  amount,
  accountTypes,
  loading,
  onBuy,
}: {
  amount: number;
  /** The types the server will charge, in the order it will drain them. */
  accountTypes: BuzzSpendType[];
  loading?: boolean;
  onBuy: () => void;
}) {
  const {
    data: { accounts },
  } = useQueryBuzz(accountTypes);
  const { conditionalPerformTransaction, hasRequiredAmount, isLoadingBalance } = useBuzzTransaction(
    {
      message: "You don't have enough Buzz for this sticker. Buy or earn more to grab it.",
      accountTypes,
    }
  );

  const distribution = getBuzzTypeDistribution({ accounts, buzzAmount: amount });
  const payingType = (Object.entries(distribution.amt).reduce(
    (max, [type, value]) => (value > (distribution.amt[max as BuzzSpendType] ?? 0) ? type : max),
    Object.keys(distribution.amt)[0] ?? accountTypes[0]
  ) ?? accountTypes[0]) as BuzzSpendType;
  const config = useBuzzCurrencyConfig(payingType);

  const affordable = hasRequiredAmount(amount);
  const disabled = loading || isLoadingBalance;

  return (
    <Tooltip
      label={
        affordable
          ? `${numberWithCommas(amount)} Buzz`
          : 'Not enough Buzz — click to top up and buy it'
      }
      withArrow
      openDelay={300}
    >
      <UnstyledButton
        onClick={disabled ? undefined : () => conditionalPerformTransaction(amount, onBuy)}
        disabled={disabled}
        aria-label={`Buy for ${numberWithCommas(amount)} Buzz`}
        className={clsx(
          'flex h-6 w-full items-center justify-center gap-0.5 rounded-full px-2 font-bold leading-none transition-opacity',
          disabled && 'opacity-60',
          // Short balance keeps the colour and loses the fill: it is still this
          // sticker's price in this sticker's currency, and it still opens the
          // top-up, so hiding it behind a grey button would misreport both.
          affordable
            ? clsx('text-white', config.classNames?.gradient ?? 'bg-yellow-6')
            : 'border border-current bg-transparent'
        )}
        style={affordable ? undefined : { color: config.color }}
      >
        {loading ? (
          <Loader size={12} color={affordable ? 'white' : config.color} />
        ) : (
          <>
            <IconBolt size={12} fill="currentColor" stroke={0} />
            <Text inherit size="10px" lh={1}>
              {abbreviateNumber(amount)}
            </Text>
          </>
        )}
      </UnstyledButton>
    </Tooltip>
  );
}
