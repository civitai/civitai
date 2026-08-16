import { Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import clsx from 'clsx';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getBuzzTypeDistribution } from '~/utils/buzz';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * What a sticker costs, on its tile in the shop.
 *
 * A label, not a control: buying happens on the image, after you have dragged
 * the sticker there and seen it in place. A button here would be a second way
 * to buy that skips the part the whole panel exists for.
 *
 * The colour is not decoration. Which Buzz would fund the purchase depends on
 * the domain (yellow on .com, green on .green) and on whether the seller accepts
 * Blue, so the caller passes the types the server would charge and the bolt
 * takes the colour of whichever one pays the larger share. A yellow bolt on a
 * purchase that spends Blue tells the buyer the wrong thing about their own
 * balance — and it has to match the button they will meet on the image.
 */
export function StickerPriceBadge({
  amount,
  accountTypes,
  className,
}: {
  amount: number;
  /** The types the server would charge, in the order it would drain them. */
  accountTypes: BuzzSpendType[];
  className?: string;
}) {
  const {
    data: { accounts },
  } = useQueryBuzz(accountTypes);

  const distribution = getBuzzTypeDistribution({ accounts, buzzAmount: amount });
  const payingType = (Object.entries(distribution.amt).reduce(
    (max, [type, value]) => (value > (distribution.amt[max as BuzzSpendType] ?? 0) ? type : max),
    Object.keys(distribution.amt)[0] ?? accountTypes[0]
  ) ?? accountTypes[0]) as BuzzSpendType;
  const config = useBuzzCurrencyConfig(payingType);

  return (
    <div
      className={clsx(
        'flex h-5 items-center gap-0.5 rounded-full px-1.5 font-bold leading-none text-white',
        config.classNames?.gradient ?? 'bg-yellow-6',
        className
      )}
    >
      <IconBolt size={11} fill="currentColor" stroke={0} />
      <Text inherit size="10px" lh={1}>
        {abbreviateNumber(amount)}
      </Text>
    </div>
  );
}
