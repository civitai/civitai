import clsx from 'clsx';
import { useEffect, useState } from 'react';
import { CustomNumberFlow } from '~/components/Metrics/CustomNumberFlow';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useBuzzDeltaGroups } from '~/store/buzz-delta.store';
import type { BuzzDeltaDirection, BuzzDeltaSummary } from '~/store/buzz-delta.store';
import classes from './BuzzDeltaPop.module.scss';

const EXIT_MS = 600;

type Lines = Partial<Record<BuzzDeltaDirection, BuzzDeltaSummary>>;

function PopLine({ direction, total }: { direction: BuzzDeltaDirection; total: number }) {
  // Mounting at 0 and then moving to the total is what rolls the digits in.
  const [value, setValue] = useState(0);
  useEffect(() => setValue(total), [total]);

  return (
    <span className={clsx(classes.line, direction === 'debit' ? classes.debit : classes.credit)}>
      {direction === 'debit' ? '−' : '+'}
      <CustomNumberFlow value={value} />
    </span>
  );
}

/**
 * The "-N" that rolls out of a Buzz counter. Hidden from assistive tech on purpose:
 * `SignalNotifications` announces each settled group once instead.
 */
export function BuzzDeltaPop({ accountTypes }: { accountTypes: BuzzSpendType[] }) {
  const open = useBuzzDeltaGroups(accountTypes);
  const isOpen = !!open.debit || !!open.credit;
  const [lines, setLines] = useState<Lines | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLines(open);
      setExiting(false);
      return;
    }
    if (!lines) return;
    setExiting(true);
    const timer = setTimeout(() => {
      setLines(null);
      setExiting(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [isOpen, open, lines]);

  if (!lines) return null;

  return (
    <span
      aria-hidden="true"
      className={clsx(
        classes.pop,
        exiting && classes.exiting,
        (lines.debit?.big || lines.credit?.big) && classes.big
      )}
    >
      {lines.debit && <PopLine direction="debit" total={lines.debit.total} />}
      {lines.credit && <PopLine direction="credit" total={lines.credit.total} />}
    </span>
  );
}
