import { Badge, Text } from '@mantine/core';
import type { BadgeProps } from '@mantine/core';
import {
  IconBolt,
  IconCircleCheck,
  IconLock,
  IconRosetteDiscountCheck,
  IconRoute,
  IconShieldHalf,
} from '@tabler/icons-react';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import clsx from 'clsx';
import { browsingLevelLabels } from '~/shared/constants/browsingLevel.constants';
import { numberWithCommas } from '~/utils/number-helpers';

/** The design system's one chip (G1): light, small, round; on an image, a dark translucent fill. */
function Chip({
  onImage,
  className,
  ...props
}: Omit<BadgeProps, 'size' | 'radius' | 'variant'> & {
  onImage?: boolean;
  title?: string;
  'data-testid'?: string;
}) {
  return (
    <Badge
      size="sm"
      radius="xl"
      variant="light"
      className={clsx(onImage && '!bg-black/55 !text-white backdrop-blur-sm', className)}
      {...props}
    />
  );
}

export function StorylineStatusChip({
  status,
  onImage,
  className,
}: {
  status: 'Ongoing' | 'Complete';
  onImage?: boolean;
  className?: string;
}) {
  const complete = status === 'Complete';
  return (
    <Chip
      onImage={onImage}
      className={className}
      color={complete ? 'gray' : 'green'}
      leftSection={
        complete ? (
          <IconCircleCheck size={12} />
        ) : (
          <span className="block size-1.5 rounded-full bg-green-5" />
        )
      }
      data-testid="storyline-status-chip"
    >
      {status}
    </Chip>
  );
}

/** Why a reader may not continue: closed to everyone, or only to collaborators. */
export function StorylineClosedChip({
  label,
  onImage,
  className,
}: {
  label: 'Closed' | 'Collaborators only';
  onImage?: boolean;
  className?: string;
}) {
  return (
    <Chip
      onImage={onImage}
      className={className}
      color="gray"
      leftSection={<IconLock size={12} />}
      data-testid="storyline-closed-chip"
    >
      {label}
    </Chip>
  );
}

/** What continuing costs. `short` drops "to continue" where space is tight, keeping it as a tooltip. */
export function StorylinePriceChip({
  price,
  short,
  className,
}: {
  price: number;
  short?: boolean;
  className?: string;
}) {
  const priced = price > 0;
  const full = priced ? `${numberWithCommas(price)} to continue` : 'Free to continue';
  return (
    <Chip
      className={className}
      color={priced ? 'yellow' : 'green'}
      leftSection={priced ? <IconBolt size={12} /> : undefined}
      title={short ? (priced ? `${numberWithCommas(price)} Buzz to continue` : full) : undefined}
      data-testid="storyline-price-chip"
    >
      {short ? (priced ? numberWithCommas(price) : 'Free') : full}
    </Chip>
  );
}

/** The storyline's rating ceiling, "Up to PG-13". */
export function StorylineCeilingChip({ maxNsfwLevel }: { maxNsfwLevel: number }) {
  const label = browsingLevelLabels[maxNsfwLevel as keyof typeof browsingLevelLabels];
  if (!label) return null;
  return (
    <Chip
      color="gray"
      leftSection={<IconShieldHalf size={12} />}
      data-testid="storyline-ceiling-chip"
    >
      Up to {label}
    </Chip>
  );
}

export function StorylineRoleChip({ role }: { role: 'creator' | 'endorsed' | 'contributor' }) {
  if (role === 'contributor') return null;
  const creator = role === 'creator';
  return (
    <Chip
      color={creator ? 'violet' : 'teal'}
      leftSection={creator ? <IconRoute size={12} /> : <IconRosetteDiscountCheck size={12} />}
      data-testid="storyline-role-chip"
    >
      {creator ? 'Creator' : 'Endorsed'}
    </Chip>
  );
}

/** An icon and a count, with the noun for screen readers and as a tooltip (G2). */
export function StorylineStat({
  icon: Icon,
  count,
  one,
  many,
  showLabel,
  size = 'xs',
}: {
  icon: TablerIcon;
  count: number;
  one: string;
  many: string;
  /** Print the noun beside the count, not only for screen readers. */
  showLabel?: boolean;
  size?: 'xs' | 'sm';
}) {
  const label = count === 1 ? one : many;
  return (
    <Text
      component="span"
      size={size}
      c="dimmed"
      className="flex items-center gap-1"
      title={`${count} ${label}`}
    >
      <Icon size={size === 'sm' ? 15 : 14} stroke={2} aria-hidden />
      {count}
      <span className={showLabel ? undefined : 'sr-only'}>{` ${label}`}</span>
    </Text>
  );
}
