import dayjs from 'dayjs';

export const DaysFromNow = ({ date, withoutSuffix = false }: Props) => {
  const day = dayjs(date);
  const datetime = day.format();
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
