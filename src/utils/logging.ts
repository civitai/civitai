import { format, stripVTControlCharacters, styleText } from 'node:util';
import { env } from '~/env/server';
import { withConsoleForwardingSuppressed } from '@civitai/axiom/console-forwarding';
import { emitConsoleLog, MAX_FORWARDED_LOG_BODY } from '~/server/logging/structured-log-sink';

type LogColor = Parameters<typeof styleText>[0];

export { MAX_FORWARDED_LOG_BODY };

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
    // Off the console backstop either way: forwarded below, or stdout-only by `forward: false`.
    withConsoleForwardingSuppressed(() => console.log(styleText(color, name), ...args));
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
