import pino from 'pino';
import { config } from '../config';

export const logger = pino({
  level: config.app.logLevel,
  transport: config.app.nodeEnv === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      }
    : config.axiom.token ? {
      target: '@axiomhq/pino',
      options: {
        dataset: config.axiom.dataset,
        token: config.axiom.token,
      },
    } : undefined,
});