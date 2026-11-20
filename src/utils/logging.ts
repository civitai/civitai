import { format, stripVTControlCharacters, styleText } from 'node:util';
import { env } from '~/env/server';
import { emitConsoleLog } from '~/server/logging/structured-log-sink';

type LogColor = Parameters<typeof styleText>[0];

// One record's body; a longer line is cut here (stdout still gets all of it).
export const MAX_FORWARDED_LOG_BODY = 8192;

/**
 * `forward: false` keeps a logger stdout-only. Use it for a logger that runs once per DB statement
 * or query: forwarding those would put one record per statement into the export queue that also
 * carries the app's structured logs.
 */
export function createLogger(
  name: string,
  color: LogColor = 'green',
  { forward = true }: { forward?: boolean } = {}
) {
  const shouldLog = env.LOGGING.includes(name);
  if (!shouldLog) return () => {}; //eslint-disable-line

  return (...args: any[]) => {
    //eslint-disable-line
    console.log(styleText(color, name), ...args);
    if (!forward) return;
    emitConsoleLog(
      stripVTControlCharacters(format(name, ...args)).slice(0, MAX_FORWARDED_LOG_BODY),
      {
        source: 'createLogger',
        name,
        type: 'info',
      }
    );
  };
}
