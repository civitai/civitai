import dayjs from 'dayjs';
import useIsClient from '~/hooks/useIsClient';

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
  date: dayjs.ConfigType;
  withoutSuffix?: boolean;
  inUtc?: boolean;
};
