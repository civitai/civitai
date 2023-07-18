import { useInterval } from '@mantine/hooks';
import dayjs from 'dayjs';
import plugin from 'dayjs/plugin/duration';
import { useState, useEffect, useRef } from 'react';
import useIsClient from '~/hooks/useIsClient';
import { toStringList } from '~/utils/array-helpers';

function getCountdownString(duration: plugin.Duration, withSeconds?: boolean) {
  const days = duration.days();
  const hours = duration.hours();
  const minutes = duration.minutes();
  const seconds = duration.seconds();

  const countdownTuple = [];
  if (days > 0) countdownTuple.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) countdownTuple.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) countdownTuple.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds > 0 && withSeconds)
    countdownTuple.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);

  return toStringList(countdownTuple);
}

export function CountdownOld({ endTime, refreshIntervalMs = 1000 * 60 }: Props) {
  const currentTime = dayjs();
  const diffTime = dayjs(endTime).unix() - currentTime.unix();
  const isClient = useIsClient();

  let duration = dayjs.duration(diffTime * 1000, 'milliseconds');
  const withSeconds = duration.asHours() < 1;
  const interval = withSeconds ? 1000 : refreshIntervalMs;
  const [time, setTime] = useState(() => getCountdownString(duration, withSeconds));

  const timer = useInterval(() => {
    duration = dayjs.duration(duration.asMilliseconds() - interval, 'milliseconds');
    const durationString = getCountdownString(duration, withSeconds);

    setTime(durationString);
  }, interval);

  // useEffect(() => console.log({ endTime }), [endTime]);

  useEffect(() => {
    timer.start();
    return timer.stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isClient) return null;

  return <>{time}</>;
}

type Props = { endTime: Date; refreshIntervalMs?: number };

export function Countdown({ endTime, refreshIntervalMs = 1000 * 60 }: Props) {
  const intervalRef = useRef<NodeJS.Timer>();
  const currentTime = dayjs();
  const diffTime = dayjs(endTime).unix() - currentTime.unix();
  const isClient = useIsClient();

  const duration = dayjs.duration(diffTime * 1000, 'milliseconds');
  const withSeconds = duration.asHours() < 1;
  const interval = withSeconds ? 1000 : refreshIntervalMs;
  const [time, setTime] = useState(duration);

  useEffect(() => {
    setTime(duration);
  }, [endTime]); //eslint-disable-line

  useEffect(() => {
    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        setTime((duration) => {
          const formatted = dayjs.duration(duration.asMilliseconds() - interval, 'milliseconds');
          return formatted;
        });
      }, interval);
    }
    return () => {
      // console.log('clear', { endTime, interval });
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    };
  }, [endTime, interval]);

  if (!isClient) return null;

  return <>{getCountdownString(time, withSeconds)}</>;
}
