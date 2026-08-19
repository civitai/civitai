import { Group, Text, Tooltip } from '@mantine/core';
import { IconTag } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ModelVersionTerms } from '@civitai/buzz';
import { formatDate } from '~/utils/date-helpers';

/**
 * The strikethrough is drawn from `sale.listTerms`, which the server sends alongside the already-
 * discounted `terms`. Recomputing it on the client would be a second implementation of the discount,
 * and the two would be free to disagree about the price the buyer is about to be charged.
 */
export function ModelVersionSaleBadge({
  sale,
  className,
}: {
  sale: { listTerms: ModelVersionTerms; endsAt: Date | string } | null | undefined;
  className?: string;
}) {
  const listPrice = sale?.listTerms.download?.price;
  if (!sale || listPrice == null) return null;

  const endsAt = new Date(sale.endsAt);

  return (
    <Tooltip label={`Sale ends ${formatDate(endsAt, 'MMM D, YYYY h:mm A')}`} withArrow>
      <Group gap={6} wrap="nowrap" className={clsx('items-center', className)}>
        <IconTag size={16} className="text-green-6" />
        <Text size="xs" fw={600} className="text-green-6">
          On sale
        </Text>
        <Text size="xs" c="dimmed" td="line-through">
          {listPrice.toLocaleString()} Buzz
        </Text>
      </Group>
    </Tooltip>
  );
}
