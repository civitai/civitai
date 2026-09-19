import { describe, expect, it, vi } from 'vitest';
import type * as ClickhouseDriver from '@clickhouse/client';

import { createClickhouseClient } from '@civitai/clickhouse/client';

const createClient = vi.hoisted(() => vi.fn(() => ({})));
vi.mock('@clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ClickhouseDriver>()),
  createClient,
}));

/**
 * 🔴 IF YOU ARE HERE TO DELETE THESE, READ THIS FIRST.
 *
 * `tsc` catches a MISSPELLED top-level or `keep_alive` option, because the config is an
 * inline literal. It catches nothing else here: every option is optional, so a removed one
 * compiles, and `clickhouse_settings` accepts any string key, so a misspelled setting
 * compiles too. The values, and the settings key below, are protected by this file alone.
 *
 * `@clickhouse/client` 1.x resolves three of these differently from the 0.2.x the repo
 * ran until the 1.x upgrade, which deliberately held each at its pre-upgrade value so the
 * version change moved the transport and nothing else. Dropping one silently adopts the
 * 1.x default: a bound pool that queues without a socket timer, a request ceiling an
 * order of magnitude tighter than the jobs on this client need, or responses that cross
 * the network uncompressed.
 *
 * `eagerly_destroy_stale_sockets` is the exception and is NOT a pin: 0.2.x had no
 * equivalent, and it is a deliberate non-default standing in for the retry 1.x removed.
 * See the comment beside it in packages/civitai-clickhouse/src/client.ts.
 *
 * Change any of them on purpose, with a measurement, and change this test in the same
 * commit.
 */
describe('shared ClickHouse client transport config', () => {
  function buildConfig() {
    createClient.mockClear();
    createClickhouseClient({ host: 'http://clickhouse.invalid:8123' });
    // Not decoration. A factory that stopped calling createClient would otherwise fail as a
    // TypeError on `calls[0]`, which reads like a broken test file; one that built a second,
    // unpinned client would otherwise pass silently on the first.
    expect(createClient).toHaveBeenCalledTimes(1);
    return createClient.mock.calls[0][0] as Record<string, unknown>;
  }

  it('pins max_open_connections to Infinity, not the 1.x default of 10', () => {
    expect(buildConfig().max_open_connections).toBe(Infinity);
  });

  it('pins request_timeout to 300_000, not the 1.x default of 30_000', () => {
    expect(buildConfig().request_timeout).toBe(300_000);
  });

  it('pins response compression on, which 1.x turns off when unset', () => {
    expect(buildConfig().compression).toEqual({ response: true });
  });

  // 64-bit integers arrive as strings without this, silently, in every consumer.
  it('pins the 64-bit integer output format', () => {
    expect(buildConfig().clickhouse_settings).toMatchObject({
      output_format_json_quote_64bit_integers: 0,
    });
  });

  // The TTL has to stay under the server's 10s keep_alive_timeout; the eager sweep is the
  // deliberate non-default, asserted here so it cannot be dropped without a decision.
  it('keeps the idle socket TTL under the server keep-alive and sweeps stale sockets eagerly', () => {
    expect(buildConfig().keep_alive).toEqual({
      enabled: true,
      idle_socket_ttl: 2500,
      eagerly_destroy_stale_sockets: true,
    });
  });
});
