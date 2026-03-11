import { useEffect, useState } from 'react';
import dayjs from '~/shared/utils/dayjs';
import useIsClient from '~/hooks/useIsClient';
import type { ConfigType } from 'dayjs';

export const DaysFromNow = ({ date, withoutSuffix = false, inUtc = false, live = false }: Props) => {
  const day = inUtc ? dayjs.utc(date) : dayjs(date);
  const datetime = day.format();
  const isClient = useIsClient();

  // Tick periodically so relative text stays fresh
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [live]);

  if (!isClient) return null;

  return (
    <time title={datetime} dateTime={datetime}>
      {day.fromNow(withoutSuffix)}
    </time>
  );
};

type Props = {
  date: ConfigType;
  withoutSuffix?: boolean;
  inUtc?: boolean;
  /** Re-render every 15s to keep relative time fresh */
  live?: boolean;
};
