import { describe, expect, it, vi } from 'vitest';
import {
  COOC_RETENTION_HEARTBEAT_KEY,
  runCoocRetentionSweep,
  type CoocHeartbeatStore,
} from '~/server/services/resource-intent-cooc/heartbeat';
import type { CoocSql } from '~/server/services/resource-intent-cooc/store';
import { freshDb, seed } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date('2026-10-08T12:00:00Z');

function durableKv() {
  const rows = new Map<string, unknown>();
  const kv = {
    keyValue: {
      upsert: async (a: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        const value = rows.has(a.where.key) ? a.update.value : a.create.value;
        rows.set(a.where.key, value);
        return { key: a.where.key, value };
      },
    },
  } as unknown as CoocHeartbeatStore;
  return { kv, rows };
}

describe('cooc retention heartbeat', () => {
  it('a successful sweep, even one that deletes nothing, writes the heartbeat', async () => {
    const { sql } = await freshDb();
    const { kv, rows } = durableKv();
    expect(await runCoocRetentionSweep(sql, kv, NOW)).toEqual({ deleted: 0, tableMissing: false });
    expect(rows.get(COOC_RETENTION_HEARTBEAT_KEY)).toBe(NOW.getTime());
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
  });
});
