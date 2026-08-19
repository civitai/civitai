import { Group, Text, Tooltip } from '@mantine/core';
import { IconTag } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ModelVersionTerms } from '@civitai/buzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';

export type SaleDisplay = {
  listTerms: ModelVersionTerms;
  endsAt: Date | string;
  discountType: 'Fixed' | 'Percent';
  discountAmount: number;
};

/**
 * The discount as the creator set it, never derived on the client. A fixed discount is rendered as the
 * Buzz bolt plus the number rather than the word "Buzz", which is how currency reads everywhere else and
 * keeps the chip short enough to sit beside Early Access and New.
 */
export function SaleDiscountLabel({
  sale,
  size = 'xs',
}: {
  sale: { discountType: 'Fixed' | 'Percent'; discountAmount: number };
  size?: 'xs' | 'sm';
}) {
  if (sale.discountType === 'Percent') return <>{sale.discountAmount}% off</>;
  return (
    <span className="inline-flex items-center gap-0.5">
      <CurrencyIcon currency={Currency.BUZZ} size={size === 'xs' ? 12 : 14} stroke={2.5} />
      {sale.discountAmount.toLocaleString()} off
    </span>
  );
}

/** Plain-text form, for a tooltip or an aria-label where a component cannot go. */
export const saleDiscountText = (sale: {
  discountType: 'Fixed' | 'Percent';
  discountAmount: number;
}) =>
  sale.discountType === 'Percent'
    ? `${sale.discountAmount}% off`
    : `${sale.discountAmount.toLocaleString()} Buzz off`;

/**
 * The struck-through price comes from `sale.listTerms`, which the server sends beside the already
 * discounted `terms`. Recomputing it here would be a second implementation of the discount, free to
 * disagree with the one that charges.
 *
 * `isOwner` only changes the wording: an owner is quoted their stored price, so "your sale" reads
 * correctly where "on sale" would imply they are being charged it.
 */
export function ModelVersionSaleBadge({
  sale,
  isOwner,
  className,
}: {
  sale: SaleDisplay | null | undefined;
  isOwner?: boolean;
  className?: string;
}) {
  const listPrice = sale?.listTerms.download?.price;
  if (!sale) return null;

  const endsAt = new Date(sale.endsAt);

  return (
    <Tooltip label={`Sale ends ${formatDate(endsAt, 'MMM D, YYYY h:mm A')}`} withArrow>
      <Group gap={6} wrap="nowrap" className={clsx('items-center', className)}>
        <IconTag size={16} className="text-green-6" />
        <Text size="xs" fw={600} className="text-green-6">
          {isOwner ? (
            <>
              Your sale — <SaleDiscountLabel sale={sale} />
            </>
          ) : (
            <SaleDiscountLabel sale={sale} />
          )}
        </Text>
        {listPrice != null && !isOwner && (
          <Text size="xs" c="dimmed" td="line-through">
            {listPrice.toLocaleString()} Buzz
          </Text>
        )}
        <Text size="xs" c="dimmed">
          until {formatDate(endsAt, 'MMM D')}
        </Text>
      </Group>
    </Tooltip>
  );
}
