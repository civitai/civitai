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
  // The page shows the sale price to everyone now, so a strikethrough would repeat the line below it.
  // The OWNER instead gets the number that vanished from the page — their own list price. A moderator
  // gets neither: it is not their price, and not their sale.
  const showStrikethrough = !isOwner && !isModerator;

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
              {isOwner && listPrice != null && (
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
        {showStrikethrough && listPrice != null && (
          <Text size="sm" c="dimmed" td="line-through" className="whitespace-nowrap">
            {listPrice.toLocaleString()} Buzz
          </Text>
        )}
      </Group>
    </Card>
  );
}
