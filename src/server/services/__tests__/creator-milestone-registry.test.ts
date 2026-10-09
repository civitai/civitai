import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  activityMeasureOf,
  creatorMilestoneRegistry,
  isMilestoneAnnounced,
  milestoneKeysFor,
} from '~/server/services/creator-milestone-registry';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The registry and the CreatorMilestone rows are two halves of one definition, so this runs every
 * migration that touches the table, in order, and compares against what they seed.
 */

const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');

type SeededRow = {
  key: string;
  track: string;
  threshold: number | null;
  hidden: boolean;
  hint: string | null;
};

function hiddenWithoutHint(rows: SeededRow[]) {
  return rows.filter((row) => row.hidden && !row.hint?.trim()).map((row) => row.key);
}

let seeded: SeededRow[] = [];

beforeAll(async () => {
  const migrations = readdirSync(MIGRATIONS)
    .sort()
    .map((dir) => join(MIGRATIONS, dir, 'migration.sql'))
    .filter((file) => {
      try {
        return readFileSync(file, 'utf8').includes('"CreatorMilestone"');
      } catch {
        return false;
      }
    });
  expect(migrations.length).toBeGreaterThan(0);

  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id int PRIMARY KEY);
    CREATE TABLE "Cosmetic" (id serial PRIMARY KEY, name text);
  `);
  for (const file of migrations) await db.exec(readFileSync(file, 'utf8'));
  seeded = (
    await db.query<SeededRow>(
      `SELECT key, track, threshold, hidden, hint FROM "CreatorMilestone" ORDER BY key`
    )
  ).rows;
  await db.close();
});

describe('creator milestone registry', () => {
  it('defines exactly the keys the migrations seed', () => {
    expect(Object.keys(creatorMilestoneRegistry).sort()).toEqual(seeded.map((row) => row.key));
  });

  it('points the score detector only at score rows that have a threshold', () => {
    const byKey = new Map(seeded.map((row) => [row.key, row]));
    const keys = milestoneKeysFor('scoreSnapshot');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(byKey.get(key), key).toMatchObject({ track: 'score' });
      expect(byKey.get(key)?.threshold, key).not.toBeNull();
    }
  });

  it('seeds every activity key with the track and threshold its name states', () => {
    const activity = seeded.filter((row) => row.track !== 'score');
    expect(activity.length).toBeGreaterThan(0);
    for (const row of activity) {
      const [track, rest] = row.key.split(':');
      expect({ key: row.key, track: row.track, threshold: row.threshold }).toEqual({
        key: row.key,
        track,
        threshold: Number(rest.split('-').pop()),
      });
    }
  });

  // Product decision (2026-10-09): every visible ladder runs wood, bronze, silver, gold, diamond,
  // one rung per metal, so every measure has exactly five rungs. Adding or dropping a rung means
  // re-deciding the badge art for the whole ladder; change this only with that decision.
  it('gives every activity measure exactly five rungs, one per badge metal', () => {
    const rungs = new Map<string, number[]>();
    for (const [key, entry] of Object.entries(creatorMilestoneRegistry)) {
      const measure = activityMeasureOf(entry);
      if (!measure) continue;
      rungs.set(measure, [...(rungs.get(measure) ?? []), Number(key.split('-').pop())]);
    }
    expect(Object.fromEntries([...rungs].map(([measure, list]) => [measure, list.length]))).toEqual(
      {
        models: 5,
        articles: 5,
        downloads: 5,
        followers: 5,
        reactions: 5,
        revenue: 5,
        votes: 5,
        wins: 5,
      }
    );
  });

  it('gives every definition a real launch date', () => {
    for (const [key, definition] of Object.entries(creatorMilestoneRegistry)) {
      expect(Number.isNaN(definition.launchedAt.getTime()), key).toBe(false);
    }
  });

  it('gives every hidden milestone a hint', () => {
    expect(hiddenWithoutHint(seeded)).toEqual([]);
  });

  it('flags a hidden milestone with no hint', () => {
    const row = { key: 'hidden:x', track: 'hidden', threshold: null, hidden: true };
    expect(
      hiddenWithoutHint([
        { ...row, hint: null },
        { ...row, key: 'hidden:y', hint: '  ' },
        { ...row, key: 'hidden:z', hint: 'A clue.' },
      ])
    ).toEqual(['hidden:x', 'hidden:y']);
  });
});

describe('isMilestoneAnnounced', () => {
  const launchedAt = new Date('2026-10-06T00:00:00Z');
  const registry = { 'score:x': { detector: 'scoreSnapshot' as const, params: {}, launchedAt } };

  it('announces from the launch instant on, and silences anything earlier', () => {
    expect(isMilestoneAnnounced('score:x', new Date(launchedAt.getTime() - 1), registry)).toBe(
      false
    );
    expect(isMilestoneAnnounced('score:x', launchedAt, registry)).toBe(true);
  });

  it('never announces a key the registry does not define', () => {
    expect(isMilestoneAnnounced('score:missing', new Date('2030-01-01'), registry)).toBe(false);
  });
});
