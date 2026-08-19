import { Group, Text, Tooltip } from '@mantine/core';
import { IconTag } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ModelVersionTerms } from '@civitai/buzz';
import { formatDate } from '~/utils/date-helpers';

export type SaleDisplay = {
  listTerms: ModelVersionTerms;
  endsAt: Date | string;
  discountType: 'Fixed' | 'Percent';
  discountAmount: number;
};

/** "25% off" / "300 Buzz off" — the discount as the creator set it, not a figure derived on the client. */
export const saleDiscountLabel = (sale: {
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
          {isOwner ? `Your sale — ${saleDiscountLabel(sale)}` : saleDiscountLabel(sale)}
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
