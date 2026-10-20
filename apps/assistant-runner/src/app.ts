import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { Authenticator } from './interfaces';
import type { RunService } from './service';

export interface AppOptions {
  service: RunService;
  authenticator?: Authenticator;
  logger?: FastifyServerOptions['logger'];
  keepaliveMs?: number;
}

// Stub: the run API lands in the next commit.
export function lastEventId(_header: string | string[] | undefined): number | undefined {
  return undefined;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

export function loggerOptions(level: string): FastifyServerOptions['logger'] {
  return { level };
}
