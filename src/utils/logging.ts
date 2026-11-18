import { styleText } from 'node:util';
import { env } from '~/env/server';

type LogColor = Parameters<typeof styleText>[0];

export function createLogger(name: string, color: LogColor = 'green') {
  const shouldLog = env.LOGGING.includes(name);
  if (!shouldLog) return () => {}; //eslint-disable-line

  return (...args: any[]) => {
    //eslint-disable-line
    console.log(styleText(color, name), ...args);
  };
}
