import { dbWrite } from '~/server/db/client';
import chalk from 'chalk';
import { env } from '~/env/server.mjs';
import { isDev } from '~/env/other';

export async function logToDb(event: string, details: object) {
  if (isDev) return; // Don't log in dev
  try {
    await dbWrite.log.createMany({
      data: {
        event,
        details,
      },
    });
  } catch (e) {
    console.error('Failed to log', e);
  }
}

type ChalkColor =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'blackBright'
  | 'redBright'
  | 'greenBright'
  | 'yellowBright'
  | 'blueBright'
  | 'magentaBright'
  | 'cyanBright'
  | 'whiteBright';

export function createLogger(name: string, color: ChalkColor = 'green') {
  const shouldLog = env.LOGGING.includes(name);
  if (!shouldLog) return () => {}; //eslint-disable-line

  return (...args: any[]) => { //eslint-disable-line
    console.log(chalk[color](name), ...args);
  };
}
