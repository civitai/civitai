import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import client from 'prom-client';
import { describe, expect, it, vi } from 'vitest';
import {
  createNewestReadyGauge,
  createTagIndexHeartbeatGauges,
  TAG_INDEX_METRICS,
} from '~/server/prom/resource-intent-tags.metrics';
import {
  readNewestReadyCreatedAt,
  readTagIndexHeartbeats,
  runTagIndexJob,
  TAG_INDEX_HEARTBEAT_KEYS,
  type TagIndexHeartbeatStore,
} from '~/server/services/resource-intent-tags/heartbeat';
import { asFixtureWriter, pgliteSql, utcPglite } from './resource-intent-cooc.harness';

/**
 * The weekly job's persisted heartbeats and their gauges, the newest-ready gauge an 8-day staleness
 * alert reads, and the holder's per-pod metrics.
 */
vi.setConfig({ testTimeout: 60_000 });

const NOW = new Date('2026-11-10T07:30:00Z');

/** A KeyValue table that outlives any one "process". */
function durableKv() {
  const rows = new Map<string, unknown>();
  const kv = {
    keyValue: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((k) => rows.has(k)).map((key) => ({ key, value: rows.get(key) })),
      upsert: async (a: {
        where: { key: string };
        create: { key: string; value: unknown };
        update: { value: unknown };
      }) => {
        rows.set(a.where.key, rows.has(a.where.key) ? a.update.value : a.create.value);
        return { key: a.where.key, value: rows.get(a.where.key) };
      },
    },
  } as unknown as TagIndexHeartbeatStore;
  return { kv, rows };
}

const sec = (d: Date) => d.getTime() / 1000;

describe('runTagIndexJob', () => {
  it('a successful build records its success, then retention runs and records its own', async () => {
    const { kv, rows } = durableKv();
    const order: string[] = [];
    const result = await runTagIndexJob({
      build: async () => (order.push('build'), { created: true }),
      retention: async () => (order.push('retention'), { retired: ['x'] }),
      kv,
      now: () => NOW,
    });
    expect(order).toEqual(['build', 'retention']);
    expect(result).toEqual({ build: { created: true }, retention: { retired: ['x'] } });
    expect(Object.fromEntries(rows)).toEqual({
      [TAG_INDEX_HEARTBEAT_KEYS.buildSuccess]: NOW.getTime(),
      [TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess]: NOW.getTime(),
    });
  });

  it('a failed build records nothing of its own (a stale success is the signal), still runs retention, and fails the run', async () => {
    const { kv, rows } = durableKv();
    const retention = vi.fn(async () => ({ retired: [] }));
    await expect(
      runTagIndexJob({
        build: async () => {
          throw new Error('no frozen vocabulary');
        },
        retention,
        kv,
        now: () => NOW,
      })
    ).rejects.toThrow('no frozen vocabulary');
    expect(retention).toHaveBeenCalledTimes(1);
    // Only retention's heartbeat: no build-failure key (it was written once, and read by nothing).
    expect(Object.fromEntries(rows)).toEqual({
      [TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess]: NOW.getTime(),
    });
    expect(rows.has('job:build-resource-intent-tag-index:last-failure')).toBe(false);
  });

  it('a failed retention is reported, not thrown, and writes no retention heartbeat', async () => {
    const { kv, rows } = durableKv();
    const result = await runTagIndexJob({
      build: async () => ({ created: false }),
      retention: async () => {
        throw new Error('bucket unreachable');
      },
      kv,
      now: () => NOW,
    });
    expect(result).toEqual({
      build: { created: false },
      retention: { error: 'bucket unreachable' },
    });
    expect([...rows.keys()]).toEqual([TAG_INDEX_HEARTBEAT_KEYS.buildSuccess]);
  });
});

describe('heartbeat gauges', () => {
  async function scrape(kv: TagIndexHeartbeatStore, enabled = async () => true) {
    const registry = new client.Registry();
    const { gauges, refresh } = createTagIndexHeartbeatGauges(
      () => readTagIndexHeartbeats(kv),
      enabled,
      registry
    );
    await registry.metrics();
    await refresh();
    const out: Record<string, number[]> = {};
    for (const g of gauges) {
      const got = await g.get();
      out[got.name] = got.values.map((v) => v.value);
    }
    return out;
  }

  it('are absent before any write, carry each heartbeat after, and survive a "restart"', async () => {
    const { kv, rows } = durableKv();
    expect(await scrape(kv)).toEqual({
      [TAG_INDEX_METRICS.buildLastSuccess]: [],
      [TAG_INDEX_METRICS.retentionLastSuccess]: [],
    });
    rows.set(TAG_INDEX_HEARTBEAT_KEYS.buildSuccess, NOW.getTime());
    rows.set(TAG_INDEX_HEARTBEAT_KEYS.retentionSuccess, NOW.getTime() + 5000);
    expect(await scrape(kv)).toEqual({
      [TAG_INDEX_METRICS.buildLastSuccess]: [sec(NOW)],
      [TAG_INDEX_METRICS.retentionLastSuccess]: [sec(NOW) + 5],
    });
  });
});

describe('newest ready snapshot', () => {
  const migration = (name: string) =>
    readFileSync(
      join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations', name, 'migration.sql'),
      'utf8'
    );

  it('reads the newest READY row per spec hash; a missing table reads as none', async () => {
    const bare = await utcPglite();
    expect(await readNewestReadyCreatedAt(pgliteSql(bare))).toEqual([]);

    const db = await utcPglite(
      migration('20261029120000_resource_intent_tags'),
      migration('20261103120000_resource_intent_tag_index_snapshot')
    );
    const payload = Buffer.from('{}');
    const v = createHash('sha256').update(payload).digest('hex');
    await db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary", "status", "frozenAt", "frozenBy")
       VALUES ($1, $2, '{}', 'frozen', now(), 'op')`,
      [v, payload]
    );
    const at = (d: string) => new Date(`2026-11-0${d}T00:00:00Z`);
    await asFixtureWriter(db, async () => {
      const rows: [string, string, string, Date][] = [
        ['1', 'd', 'ready', at('1')],
        ['2', 'd', 'ready', at('3')],
        ['3', 'd', 'retired', at('5')],
        ['4', 'e', 'ready', at('2')],
      ];
      for (const [n, spec, status, createdAt] of rows)
        await db.query(
          `INSERT INTO "ResourceIntentTagIndexSnapshot" ("status", "retiredAt", "vocabVersion",
             "specHash", "payloadSha256", "payloadBytes", "objectKey", "buildStats", "createdAt")
           VALUES ($1, $2, $3, $4, $5, 1, $6, '{}', $7)`,
          [
            status,
            status === 'retired' ? createdAt : null,
            v,
            spec.repeat(64),
            n.repeat(64),
            `p/${n.repeat(64)}`,
            createdAt,
          ]
        );
    });
    const got = await readNewestReadyCreatedAt(pgliteSql(db));
    expect(got.sort((a, b) => a.specHash.localeCompare(b.specHash))).toEqual([
      { specHash: 'd'.repeat(64), createdAt: at('3') },
      { specHash: 'e'.repeat(64), createdAt: at('2') },
    ]);
  });

  it('the gauge reads nothing while the build flag is off, and one series per spec hash when on', async () => {
    const read = vi.fn(async () => [
      { specHash: 'd'.repeat(64), createdAt: NOW },
      { specHash: 'e'.repeat(64), createdAt: new Date(NOW.getTime() - 1000) },
    ]);
    let on = false;
    const registry = new client.Registry();
    const { gauge, refresh } = createNewestReadyGauge(read, async () => on, registry);
    await gauge.get();
    await refresh();
    expect((await gauge.get()).values).toEqual([]);
    expect(read).not.toHaveBeenCalled();

    on = true;
    await refresh();
    expect((await gauge.get()).values).toEqual([
      { value: sec(NOW), labels: { spec_hash: 'dddddddddddd' } },
      { value: sec(NOW) - 1, labels: { spec_hash: 'eeeeeeeeeeee' } },
    ]);
  });
});
