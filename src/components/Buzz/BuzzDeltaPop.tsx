import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { CustomNumberFlow } from '~/components/Metrics/CustomNumberFlow';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useBuzzDeltaGroups } from '~/store/buzz-delta.store';
import type { BuzzDeltaDirection, BuzzDeltaSummary } from '~/store/buzz-delta.store';
import classes from './BuzzDeltaPop.module.scss';

const EXIT_MS = 600;

type Lines = Partial<Record<BuzzDeltaDirection, BuzzDeltaSummary>>;

function PopLine({
  direction,
  total,
  type,
}: {
  direction: BuzzDeltaDirection;
  total: number;
  type: BuzzSpendType;
}) {
  // Mounting at 0 and then moving to the total is what rolls the digits in.
  const [value, setValue] = useState(0);
  useEffect(() => setValue(total), [total]);

  return (
    <span data-buzz-type={type} className={clsx(classes.line, classes[type])}>
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
  // A group that opens during the exit gets fresh lines, so its digits roll up from 0.
  const [epoch, setEpoch] = useState(0);
  const wasOpen = useRef(false);
  const hasLines = !!lines;

  useEffect(() => {
    if (isOpen && !wasOpen.current) setEpoch((value) => value + 1);
    wasOpen.current = isOpen;
    if (!isOpen) return;
    setLines(open);
    setExiting(false);
  }, [isOpen, open]);

  useEffect(() => {
    if (isOpen || !hasLines) return;
    setExiting(true);
    const timer = setTimeout(() => {
      setLines(null);
      setExiting(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [isOpen, hasLines]);

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
      {lines.debit && (
        <PopLine
          key={`debit-${epoch}`}
          direction="debit"
          total={lines.debit.total}
          type={lines.debit.type}
        />
      )}
      {lines.credit && (
        <PopLine
          key={`credit-${epoch}`}
          direction="credit"
          total={lines.credit.total}
          type={lines.credit.type}
        />
      )}
    </span>
  );
}
