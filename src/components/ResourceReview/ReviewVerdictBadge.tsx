import { Badge } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';
import clsx from 'clsx';

/**
 * The "Recommends" / "Doesn't recommend" pill. `responsive` collapses to the icon alone on phones
 * (label kept for screen readers); `icon` is the 30px square of the compact card.
 */
export function ReviewVerdictBadge({
  recommended,
  variant = 'responsive',
}: {
  recommended: boolean;
  variant?: 'responsive' | 'icon';
}) {
  const icon = recommended ? <IconThumbUp size={16} /> : <IconThumbDown size={16} />;
  const label = recommended ? 'Recommends' : 'Doesn’t recommend';
  const square = variant === 'icon';

  return (
    <Badge
      color={recommended ? 'success.5' : 'red'}
      variant="light"
      radius={6}
      leftSection={icon}
      aria-label={square ? label : undefined}
      // Not interactive: clicks go through to the card's link.
      className={clsx(
        '!pointer-events-none !normal-case',
        square ? '!size-[30px] !p-0' : '!h-auto !px-2.5 !py-1.5 !text-[13px] !font-semibold'
      )}
      classNames={{ section: clsx(square ? '!m-0' : 'max-sm:!mr-0 sm:!mr-1.5') }}
    >
      {!square && <span className="sr-only sm:not-sr-only">{label}</span>}
    </Badge>
  );
}
