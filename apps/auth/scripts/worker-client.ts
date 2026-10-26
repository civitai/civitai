// Operator script for worker identity: register a workload client or an introspector client, or block a
// worker device.
//
// Usage (from apps/auth; DATABASE_URL and NEXTAUTH_SECRET must be set in the environment, nothing is read
// from .env):
//   pnpm run worker-client create --id workers-salad --name "Salad workers" --provider SaladML \
//     --accept salad-jwt --salad-group <container group id> [--salad-group ...]
//   pnpm run worker-client create --id workers-dp --name "DP workers" --provider Submodel \
//     --accept device-id
//   pnpm run worker-client introspector --id orchestrator-workers --name "Orchestrator introspection"
//   pnpm run worker-client block --device <WorkerDevice id> --reason "<why>"
//
// The package script bundles this file with esbuild first: tsx cannot import named exports from the
// workspace packages' TypeScript sources here.
//
// `create` and `introspector` print the client secret once, on stdout. It is stored only as a hash and
// cannot be shown again.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  blockWorkerDevice,
  createIntrospectorClient,
  createWorkerClient,
} from '../src/lib/server/oauth/worker-admin';
import { DEVICE_ID_TOKEN_TYPE, JWT_TOKEN_TYPE } from '../src/lib/server/oauth/constants';

const SUBJECT_TOKEN_TYPES: Record<string, string> = {
  'device-id': DEVICE_ID_TOKEN_TYPE,
  'salad-jwt': JWT_TOKEN_TYPE,
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: 'string' },
    name: { type: 'string' },
    provider: { type: 'string' },
    accept: { type: 'string', multiple: true },
    'salad-group': { type: 'string', multiple: true },
    device: { type: 'string' },
    reason: { type: 'string' },
  },
});

if (!process.env.DATABASE_URL) fail('DATABASE_URL must be set explicitly.');
let databaseUrl: URL;
try {
  databaseUrl = new URL(process.env.DATABASE_URL);
} catch {
  fail('DATABASE_URL is not a valid URL.');
}
// Same as the hub's db.ts: node-postgres verifies the full chain for sslmode=require, which the pooler's
// self-signed certificate fails.
if (databaseUrl.searchParams.has('sslmode')) databaseUrl.searchParams.set('sslmode', 'no-verify');

const db = new Kysely<DB>({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: databaseUrl.toString(), max: 1 }),
  }),
});

try {
  const [command] = positionals;
  if (command === 'create') {
    if (!values.id || !values.name || !values.provider || !values.accept?.length) {
      fail('create needs --id, --name, --provider and --accept device-id|salad-jwt');
    }
    const subjectTokenTypes = values.accept.map(
      (a) => SUBJECT_TOKEN_TYPES[a] ?? fail(`Unknown --accept ${a}; use device-id or salad-jwt`)
    );
    const { clientId, secret } = await createWorkerClient(db, {
      id: values.id,
      name: values.name,
      provider: values.provider,
      subjectTokenTypes,
      saladContainerGroupIds: values['salad-group'] ?? [],
    });
    console.log(`client_id: ${clientId}`);
    console.log(`client_secret: ${secret}`);
  } else if (command === 'introspector') {
    if (!values.id || !values.name) fail('introspector needs --id and --name');
    const { clientId, secret } = await createIntrospectorClient(db, {
      id: values.id,
      name: values.name,
    });
    console.log(`client_id: ${clientId}`);
    console.log(`client_secret: ${secret}`);
    console.error(`Add ${clientId} to OAUTH_WORKER_INTROSPECTION_CLIENT_IDS to let it introspect.`);
  } else if (command === 'block') {
    const deviceId = Number(values.device);
    if (!Number.isInteger(deviceId) || !values.reason)
      fail('block needs --device <id> and --reason');
    const { tokensDeleted } = await blockWorkerDevice(db, deviceId, values.reason);
    console.log(`Blocked device ${deviceId}; deleted ${tokensDeleted} live token(s).`);
  } else {
    fail('Usage: pnpm run worker-client create|introspector|block [options]');
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  await db.destroy();
}
