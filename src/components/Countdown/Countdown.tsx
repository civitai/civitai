import dayjs from '~/shared/utils/dayjs';
import type plugin from 'dayjs/plugin/duration';
import { useEffect, useRef, useState } from 'react';
import useIsClient from '~/hooks/useIsClient';
import { toStringList } from '~/utils/array-helpers';

function getCountdownString(
  duration: plugin.Duration,
  format: 'short' | 'long',
  withSeconds?: boolean
) {
  const days = duration.days();
  const hours = duration.hours();
  const minutes = duration.minutes();
  const seconds = duration.seconds();

  const countdownTuple = [];
  if (days > 0)
    countdownTuple.push(format === 'long' ? `${days} ${days === 1 ? 'day' : 'days'}` : `${days}d`);
  if (hours > 0)
    countdownTuple.push(
      format === 'long' ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${hours}h`
    );
  if (minutes > 0)
    countdownTuple.push(
      format === 'long' ? `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` : `${minutes}m`
    );
  if (seconds > 0 && withSeconds)
    countdownTuple.push(
      format === 'long' ? `${seconds} ${seconds === 1 ? 'second' : 'seconds'}` : `${seconds}s`
    );

  if (countdownTuple.length === 0) return 'Ended';

  return format === 'long' ? toStringList(countdownTuple) : countdownTuple.join(' ');
}

type Props = { endTime: Date; refreshIntervalMs?: number; format?: 'short' | 'long' };

export function Countdown({ endTime, refreshIntervalMs = 1000 * 60, format = 'long' }: Props) {
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
        // TODO - clear interval if endTime is less than new date
        setTime((duration) => {
          const formatted = dayjs.duration(duration.asMilliseconds() - interval, 'milliseconds');
          return formatted;
        });
      }, interval);
    }
    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = undefined;
    };
  }, [endTime, interval]);

  if (!isClient) return null;

  return <>{getCountdownString(time, format, withSeconds)}</>;
}
