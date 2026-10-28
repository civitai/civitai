#!/usr/bin/env node
/**
 * Writes the ONE environment file both servers in the parity job boot with, as a `docker run
 * --env-file`. It starts from the repo's `.env-example` (placeholder values only) and points the
 * data stores at the job's throwaway service containers. Nothing here is a real credential: the
 * session secret is random per run and exists only inside the job.
 *
 * Usage: node make-env.mjs <.env-example> <out-file>
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [examplePath, outPath] = process.argv.slice(2);
if (!examplePath || !outPath) {
  console.error('usage: make-env.mjs <.env-example> <out-file>');
  process.exit(2);
}

const env = {};
for (const raw of readFileSync(examplePath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq === -1) continue;
  let value = line.slice(eq + 1).trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  env[line.slice(0, eq).trim()] = value;
}

// The containers reach the job's service containers through the host gateway.
const HOST = 'host.docker.internal';
const pg = `postgresql://postgres:postgres@${HOST}:5432/postgres`;

Object.assign(env, {
  DATABASE_URL: pg,
  DATABASE_REPLICA_URL: pg,
  NOTIFICATION_DB_URL: pg,
  NOTIFICATION_DB_REPLICA_URL: pg,
  DATAPACKET_DATABASE_RO_URL: pg,
  REDIS_URL: `redis://${HOST}:6379/0`,
  REDIS_SYS_URL: `redis://${HOST}:6379/1`,
  NEXTAUTH_SECRET: randomBytes(32).toString('hex'),
  NEXTAUTH_URL: 'http://localhost:3000',
  // Lets the minted legacy cookie stand for its user when the identity service has no row for it,
  // as on a PR preview (see tests/preview-auth.setup.ts).
  IS_PREVIEW: 'true',
  // Both servers listen on 3000 inside their own container.
  PORT: '3000',
  HOSTNAME: '0.0.0.0',
  PODNAME: 'parity',
  // A small cap so the over-cap case needs only a few calls.
  TRPC_MAX_BATCH_SIZE: '3',
  // Traces to the job's OTLP receiver, every request sampled, exported quickly.
  OTEL_ENABLED: 'true',
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://${HOST}:4318`,
  OTEL_TRACES_SAMPLE_RATIO: '1',
  OTEL_BSP_SCHEDULE_DELAY: '500',
  OTEL_SERVICE_NAME: 'parity',
});

const lines = Object.entries(env).map(([k, v]) => {
  if (/[\r\n]/.test(v)) throw new Error(`${k}: a value with a newline cannot go in an env file`);
  return `${k}=${v}`;
});
writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(`wrote ${lines.length} variables to ${outPath}`);
