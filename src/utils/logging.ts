import { prisma } from '~/server/db/client';
import chalk from 'chalk';
import { env } from '~/env/server.mjs';

export async function logToDb(event: string, details: object) {
  if (process.env.NODE_ENV == 'development') return; // Don't log in dev
  try {
    await prisma.log.createMany({
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
