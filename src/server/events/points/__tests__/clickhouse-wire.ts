import * as appClient from '@clickhouse/client';
import { cpSync, mkdtempSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

type ClientModule = Pick<typeof appClient, 'createClient' | 'TupleParam'>;

// A second, separately loaded copy of @clickhouse/client, as in production: Next bundles the
// package into each server module graph, and the process-global client (see
// ~/server/clickhouse/client) comes from whichever graph made it first. Classes from one copy fail
// `instanceof` in the other.
export function bundledClientCopy(): ClientModule {
  const require = createRequire(import.meta.url);
  const pkg = realpathSync(dirname(require.resolve('@clickhouse/client/package.json')));
  const copy = join(mkdtempSync(join(tmpdir(), 'ch-client-copy-')), 'client');
  cpSync(pkg, copy, { recursive: true });
  return createRequire(join(copy, 'package.json'))(copy) as ClientModule;
}

// A real client pointed at a local HTTP server standing in for ClickHouse. Returns the client and
// the `param_*` values of every query it sent.
export async function fakeClickhouse(mod: ClientModule = appClient) {
  const sent: Record<string, string>[] = [];
  const server = createServer((req, res) => {
    const search = new URL(req.url ?? '', 'http://x').searchParams;
    sent.push(
      Object.fromEntries(
        [...search].filter(([k]) => k.startsWith('param_')).map(([k, v]) => [k.slice(6), v])
      )
    );
    req.resume();
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = mod.createClient({ url: `http://127.0.0.1:${port}` });
  return {
    client,
    sent,
    close: async () => {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// The `param_*` values the client sends for these query_params.
export async function wireParams(params: Record<string, unknown>, mod: ClientModule = appClient) {
  const ch = await fakeClickhouse(mod);
  try {
    const result = await ch.client.query({
      query: 'SELECT 1',
      format: 'JSONEachRow',
      query_params: params,
    });
    await result.text();
  } finally {
    await ch.close();
  }
  return ch.sent[0];
}
