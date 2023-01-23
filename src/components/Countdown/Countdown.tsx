import { useInterval } from '@mantine/hooks';
import dayjs from 'dayjs';
import plugin from 'dayjs/plugin/duration';
import { useState, useEffect } from 'react';
import { toStringList } from '~/utils/array-helpers';

function getCountdownString(duration: plugin.Duration) {
  const days = duration.days();
  const hours = duration.hours();
  const minutes = duration.minutes();
  const countdownTuple = [
    `${days} ${days === 1 ? 'day' : 'days'}`,
    `${hours} ${hours === 1 ? 'hour' : 'hours'}`,
    `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
  ];

  return toStringList(countdownTuple);
}

export function Countdown({ endTime }: Props) {
  const currentTime = dayjs();
  const diffTime = dayjs(endTime).unix() - currentTime.unix();

  let duration = dayjs.duration(diffTime * 1000, 'milliseconds');
  const interval = 1000 * 60;

  const [time, setTime] = useState(() => getCountdownString(duration));

  const timer = useInterval(() => {
    duration = dayjs.duration(duration.asMilliseconds() - interval, 'milliseconds');
    const durationString = getCountdownString(duration);

    setTime(durationString);
  }, interval);

  useEffect(() => {
    timer.start();
    return timer.stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{time}</>;
}

type Props = { endTime: Date };
