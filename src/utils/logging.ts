import { format, stripVTControlCharacters, styleText } from 'node:util';
import { env } from '~/env/server';
import { emitConsoleLog } from '~/server/logging/structured-log-sink';

type LogColor = Parameters<typeof styleText>[0];

export function createLogger(name: string, color: LogColor = 'green') {
  const shouldLog = env.LOGGING.includes(name);
  if (!shouldLog) return () => {}; //eslint-disable-line

  return (...args: any[]) => {
    //eslint-disable-line
    console.log(styleText(color, name), ...args);
    emitConsoleLog(stripVTControlCharacters(format(name, ...args)), {
      source: 'createLogger',
      name,
      type: 'info',
    });
  };
}
