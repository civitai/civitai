import { createClient } from '@clickhouse/client';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// The `param_*` values the real ClickHouse client puts on the wire for these query_params,
// captured from a local HTTP server standing in for ClickHouse.
export async function wireParams(params: Record<string, unknown>) {
  let url = '';
  const server = createServer((req, res) => {
    url = req.url ?? '';
    req.resume();
    req.on('end', () => res.writeHead(200, { 'Content-Type': 'text/plain' }).end(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = createClient({ url: `http://127.0.0.1:${port}` });
  try {
    const result = await client.query({
      query: 'SELECT 1',
      format: 'JSONEachRow',
      query_params: params,
    });
    await result.text();
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
  const search = new URL(url, 'http://x').searchParams;
  return Object.fromEntries(
    [...search].filter(([k]) => k.startsWith('param_')).map(([k, v]) => [k.slice(6), v])
  );
}
