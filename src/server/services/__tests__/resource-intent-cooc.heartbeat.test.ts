import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import {
  COOC_RETENTION_HEARTBEAT_METRIC,
  createCoocRetentionHeartbeatGauge,
} from '~/server/prom/resource-intent-cooc.metrics';
import {
  COOC_RETENTION_HEARTBEAT_KEY,
  readCoocRetentionHeartbeat,
  runCoocRetentionSweep,
  type CoocHeartbeatStore,
} from '~/server/services/resource-intent-cooc/heartbeat';
import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import { freshDb, seed } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date('2026-10-08T12:00:00Z');

/** A KeyValue table that outlives any one "process": the durable store the heartbeat writes. */
function durableKv() {
  const rows = new Map<string, unknown>();
  const kv = {
    keyValue: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        rows.has(where.key) ? { key: where.key, value: rows.get(where.key) } : null,
      upsert: async ({ where, update }: { where: { key: string }; update: { value: unknown } }) => {
        rows.set(where.key, update.value);
        return { key: where.key, value: update.value };
      },
    },
  } as unknown as CoocHeartbeatStore;
  return { kv, rows };
}

/** A fresh registry + gauge stands for a restarted pod: no state survives but the store. */
async function scrape(kv: CoocHeartbeatStore) {
  const registry = new client.Registry();
  createCoocRetentionHeartbeatGauge(() => readCoocRetentionHeartbeat(kv), registry);
  const m = registry.getSingleMetric(COOC_RETENTION_HEARTBEAT_METRIC) as client.Gauge<string>;
  return (await m.get()).values.map((v) => v.value);
}

describe('cooc retention heartbeat', () => {
  it('a successful sweep, even one that deletes nothing, persists the heartbeat; it survives a restart', async () => {
    const { sql } = await freshDb();
    const { kv, rows } = durableKv();
    expect(await scrape(kv)).toEqual([]); // absent, not 0, before any sweep
    expect(await runCoocRetentionSweep(sql, kv, NOW)).toEqual({ deleted: 0, tableMissing: false });
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(NOW.getTime());
    expect(await scrape(kv)).toEqual([NOW.getTime() / 1000]);
    // "Restart": a new gauge in a new registry reads the same value back from the store.
    expect(await scrape(kv)).toEqual([NOW.getTime() / 1000]);
  });

  it('a failed sweep does not update the heartbeat', async () => {
    const { db, sql } = await freshDb();
    const { kv, rows } = durableKv();
    await runCoocRetentionSweep(sql, kv, NOW);
    // An overdue study row the DELETE fails to remove: the sweep throws.
    await seed(db, {
      kind: 'study',
      trainEnd: new Date(NOW.getTime() - 30 * DAY),
      builtAt: new Date(NOW.getTime() - 40 * DAY),
      pinnedUntil: new Date(NOW.getTime() - DAY),
    });
    const later = new Date(NOW.getTime() + DAY);
    const deafToDeletes: CoocSql = {
      query: sql.query,
      execute: async (s) => (s.text.startsWith('DELETE') ? 0 : sql.execute(s)),
    };
    await expect(runCoocRetentionSweep(deafToDeletes, kv, later)).rejects.toThrow(/survived/);
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(NOW.getTime());
    expect(await scrape(kv)).toEqual([NOW.getTime() / 1000]);
    // And a working sweep then succeeds and advances it.
    await runCoocRetentionSweep(sql, kv, later);
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(later.getTime());
  });

  it('an unreadable or non-numeric heartbeat scrapes as absent', async () => {
    const { kv, rows } = durableKv();
    rows.set(COOC_RETENTION_HEARTBEAT_KEY, ['1']);
    expect(await scrape(kv)).toEqual([]);
    const broken = {
      keyValue: {
        findUnique: async () => {
          throw new Error('down');
        },
      },
    } as unknown as CoocHeartbeatStore;
    expect(await scrape(broken)).toEqual([]);
  });
});
