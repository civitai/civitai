import { Anchor, Card, Group, Text, Tooltip } from '@mantine/core';
import { IconTag } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ModelVersionTerms } from '@civitai/buzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';
import { formatDate } from '~/utils/date-helpers';

export type SaleDisplay = {
  listTerms: ModelVersionTerms;
  buyerTerms: ModelVersionTerms;
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

/**
 * The prominent form, for the model page: a sale is a reason to act now, so it sits above the download
 * card rather than inside it, where it read as one more line of card furniture.
 */
export function ModelVersionSaleBanner({
  sale,
  isOwner,
  isModerator,
}: {
  sale: SaleDisplay | null | undefined;
  /** True ownership only. A moderator is not the seller and must not be told "your sale". */
  isOwner?: boolean;
  isModerator?: boolean;
}) {
  if (!sale) return null;

  const listPrice = sale.listTerms.download?.price;
  const endsAt = new Date(sale.endsAt);
  // The page now shows the sale price to everyone, owner included, so the strikethrough beside it would
  // repeat what this line already says. An owner instead gets the number that vanished from the page:
  // their own list price, which is what the sale is discounting FROM.
  const quotedStoredPrice = isOwner || isModerator;

  return (
    <Card withBorder p="sm" className="border-green-6 bg-green-0 dark:bg-green-9/20">
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Group gap={8} wrap="nowrap">
          <IconTag size={20} className="text-green-7 dark:text-green-4" />
          <div>
            <Text size="sm" fw={700} className="text-green-7 dark:text-green-4">
              {isOwner ? 'Your sale is running' : isModerator ? 'Sale running' : 'On sale'} —{' '}
              <SaleDiscountLabel sale={sale} size="sm" />
            </Text>
            <Text size="xs" c="dimmed">
              {quotedStoredPrice && listPrice != null && (
                <>Your list price is {listPrice.toLocaleString()} Buzz · </>
              )}
              Ends {formatDate(endsAt, 'MMM D, YYYY h:mm A')}
              {isOwner && (
                <>
                  {' · '}
                  <Anchor
                    href={`${CREATOR_STUDIO_URL}/sales`}
                    target="_blank"
                    rel="noreferrer"
                    inherit
                  >
                    Manage in Creator Studio
                  </Anchor>
                </>
              )}
            </Text>
          </div>
        </Group>
        {!quotedStoredPrice && listPrice != null && (
          <Text size="sm" c="dimmed" td="line-through" className="whitespace-nowrap">
            {listPrice.toLocaleString()} Buzz
          </Text>
        )}
      </Group>
    </Card>
  );
}
