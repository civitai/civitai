import dayjs from 'dayjs';
import useIsClient from '~/hooks/useIsClient';

export const DaysFromNow = ({ date, withoutSuffix = false }: Props) => {
  const day = dayjs(date);
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
  date: Date;
  withoutSuffix?: boolean;
};
