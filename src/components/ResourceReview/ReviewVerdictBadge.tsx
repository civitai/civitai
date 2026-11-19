import { Badge, ThemeIcon } from '@mantine/core';
import { IconThumbDown, IconThumbUp } from '@tabler/icons-react';

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
  const color = recommended ? 'success.5' : 'red';

  // A Badge lays out an empty label beside its icon, so the compact square would sit off-center.
  if (square)
    return (
      <ThemeIcon
        color={color}
        variant="light"
        size={30}
        radius={6}
        aria-label={label}
        className="pointer-events-none shrink-0"
      >
        {icon}
      </ThemeIcon>
    );

  return (
    <Badge
      color={color}
      variant="light"
      radius={6}
      leftSection={icon}
      // Not interactive: clicks go through to the card's link.
      className="!pointer-events-none !h-auto !px-2.5 !py-1.5 !text-[13px] !font-semibold !normal-case"
      classNames={{ section: 'max-sm:!mr-0 sm:!mr-1.5' }}
    >
      <span className="sr-only sm:not-sr-only">{label}</span>
    </Badge>
  );
}
