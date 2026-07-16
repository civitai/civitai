import { IconBolt } from '@tabler/icons-react';
import clsx from 'clsx';
import { numberWithCommas } from '~/utils/number-helpers';
import classes from './BuzzPill.module.scss';

// The Buzz cost pill shown on the storefront's Preview / Purchase buttons.
// Shared so the cosmetic and model buttons never drift.
export function BuzzPill({
  amount,
  variant = 'yellow',
  className,
}: {
  amount: number;
  variant?: 'yellow' | 'green';
  className?: string;
}) {
  return (
    <span className={clsx(classes.pill, variant === 'green' && classes.green, className)}>
      <IconBolt size={14} fill="currentColor" />
      {numberWithCommas(amount)}
    </span>
  );
}
