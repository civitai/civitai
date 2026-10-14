import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import { instrumentationRegistry } from '@civitai/telemetry/client';
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
      upsert: async (a: {
        where: { key: string };
        create: { key: string; value: unknown };
        update: { value: unknown };
      }) => {
        const value = rows.has(a.where.key) ? a.update.value : a.create.value;
        if (!rows.has(a.where.key)) expect(a.create.key).toBe(a.where.key);
        rows.set(a.where.key, value);
        return { key: a.where.key, value };
      },
    },
  } as unknown as CoocHeartbeatStore;
  return { kv, rows };
}

const values = async (g: client.Gauge<string>) => (await g.get()).values.map((v) => v.value);

/**
 * A fresh registry + gauge stands for a restarted pod: no state survives but the store. The first
 * collect starts the background read; the scrape after it completes sees the value.
 */
async function scrape(kv: CoocHeartbeatStore) {
  const { gauge, refresh } = createCoocRetentionHeartbeatGauge(
    () => readCoocRetentionHeartbeat(kv),
    new client.Registry()
  );
  await gauge.get();
  await refresh();
  return values(gauge);
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

  it('a sweep deletes an expired study and heartbeats; one that leaves it (a predicate bug) does not', async () => {
    const { db, sql } = await freshDb();
    const { kv, rows } = durableKv();
    await seed(db, {
      kind: 'study',
      trainEnd: new Date(NOW.getTime() - 30 * DAY),
      builtAt: new Date(NOW.getTime() - 20 * DAY),
      pinnedUntil: new Date(NOW.getTime() - 1),
    });
    // A selection predicate that left this row would make the sweep throw here, before the write.
    expect(await runCoocRetentionSweep(sql, kv, NOW)).toEqual({ deleted: 1, tableMissing: false });
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(NOW.getTime());
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

  it('the first heartbeat is written through create, later ones through update', async () => {
    const { sql } = await freshDb();
    const { kv, rows } = durableKv();
    await runCoocRetentionSweep(sql, kv, NOW);
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(NOW.getTime());
    const later = new Date(NOW.getTime() + DAY);
    await runCoocRetentionSweep(sql, kv, later);
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(later.getTime());
  });

  it('collect never waits on the read, reads at most once a minute, and one read at a time', async () => {
    let t = 0;
    let release: (d: Date) => void = () => undefined;
    const read = vi.fn(() => new Promise<Date | null>((r) => (release = r)));
    const { gauge } = createCoocRetentionHeartbeatGauge(read, new client.Registry(), () => t);
    // The read hangs; scrapes still return at once, with no value yet, and start no second read.
    expect(await values(gauge)).toEqual([]);
    expect(await values(gauge)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    release(NOW);
    await vi.waitFor(async () => expect(await values(gauge)).toEqual([NOW.getTime() / 1000]));
    t = 59_000;
    await values(gauge);
    expect(read).toHaveBeenCalledTimes(1);
    t = 60_000;
    await values(gauge);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('the metrics route registers the gauge on the scraped registry', async () => {
    await import('~/server/prom/resource-intent-cooc.metrics');
    expect(instrumentationRegistry.getSingleMetric(COOC_RETENTION_HEARTBEAT_METRIC)).toBeDefined();
    const route = (await import('fs')).readFileSync(
      (await import('path')).join(process.cwd(), 'src/pages/api/metrics.ts'),
      'utf8'
    );
    expect(route).toContain("import '~/server/prom/resource-intent-cooc.metrics';");
  });

  it('a failed read keeps the last value, waits a minute, then reads again', async () => {
    let t = 0;
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error('db down');
      return NOW;
    });
    const { gauge, refresh } = createCoocRetentionHeartbeatGauge(
      read,
      new client.Registry(),
      () => t
    );
    await gauge.get();
    await refresh();
    expect(await values(gauge)).toEqual([NOW.getTime() / 1000]);
    fail = true;
    t = 60_000;
    await gauge.get();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await new Promise((r) => setImmediate(r));
    expect(await values(gauge)).toEqual([NOW.getTime() / 1000]);
    t = 119_000;
    await values(gauge);
    expect(read).toHaveBeenCalledTimes(2);
    const later = new Date(NOW.getTime() + 86_400_000);
    read.mockImplementation(async () => later);
    t = 120_000;
    await gauge.get();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await new Promise((r) => setImmediate(r));
    expect(await values(gauge)).toEqual([later.getTime() / 1000]);
  });
});
