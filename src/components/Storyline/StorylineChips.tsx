import { Badge, Text, Tooltip } from '@mantine/core';
import type { BadgeProps } from '@mantine/core';
import {
  IconBolt,
  IconCircleCheck,
  IconCrown,
  IconLock,
  IconRosetteDiscountCheck,
  IconRoute,
  IconUsers,
} from '@tabler/icons-react';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import clsx from 'clsx';
import { numberWithCommas } from '~/utils/number-helpers';

export const storylineCardClass =
  'rounded-xl border border-solid border-gray-3 bg-gray-0 shadow-sm dark:border-dark-4 dark:bg-dark-6';

function Chip({
  onImage,
  className,
  ...props
}: Omit<BadgeProps, 'size' | 'radius' | 'variant'> & {
  onImage?: boolean;
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

export function StorylineOpenToAnyoneChip() {
  return (
    <Chip color="blue" leftSection={<IconUsers size={12} />} data-testid="storyline-who-chip">
      Anyone · you review
    </Chip>
  );
}

export function StorylineShareChip({
  percent,
  className,
}: {
  percent: number;
  className?: string;
}) {
  return (
    <Chip onImage color="dark" className={className} data-testid="storyline-share-chip">
      {percent}%
    </Chip>
  );
}

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
  const chip = (
    <Chip
      className={short ? undefined : className}
      color={priced ? 'yellow' : 'green'}
      leftSection={priced ? <IconBolt size={12} /> : undefined}
      data-testid="storyline-price-chip"
    >
      {short ? (priced ? numberWithCommas(price) : 'Free') : full}
    </Chip>
  );
  if (!short) return chip;
  return (
    <Tooltip label={priced ? `${numberWithCommas(price)} Buzz to continue` : full}>
      <span className={clsx('inline-flex', className)}>{chip}</span>
    </Tooltip>
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

export function StorylineRankChip({
  rank,
  onImage,
}: {
  rank: 'canon' | 'endorsed' | 'community';
  onImage?: boolean;
}) {
  if (rank === 'community') return null;
  const canon = rank === 'canon';
  return (
    <Chip
      onImage={onImage}
      color={canon ? 'blue' : 'teal'}
      leftSection={canon ? <IconCrown size={12} /> : <IconRosetteDiscountCheck size={12} />}
      data-testid="storyline-rank-chip"
    >
      {canon ? 'Canon' : 'Endorsed'}
    </Chip>
  );
}

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
  showLabel?: boolean;
  size?: 'xs' | 'sm';
}) {
  const label = count === 1 ? one : many;
  return (
    <Tooltip label={`${count} ${label}`}>
      <Text component="span" size={size} c="dimmed" className="flex items-center gap-1">
        <Icon size={size === 'sm' ? 15 : 14} stroke={2} aria-hidden />
        {count}
        <span className={showLabel ? undefined : 'sr-only'}>{` ${label}`}</span>
      </Text>
    </Tooltip>
  );
}
