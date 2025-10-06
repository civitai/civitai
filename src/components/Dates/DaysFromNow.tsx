import dayjs from '~/shared/utils/dayjs';
import useIsClient from '~/hooks/useIsClient';
import type { ConfigType } from 'dayjs';

export const DaysFromNow = ({ date, withoutSuffix = false, inUtc = false }: Props) => {
  const day = inUtc ? dayjs.utc(date) : dayjs(date);
  // TODO: support formatting
  const datetime = day.format();
  const isClient = useIsClient();

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
};
