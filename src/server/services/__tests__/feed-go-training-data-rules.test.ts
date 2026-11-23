import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { REDIS_KEYS } from '~/server/redis/client';
import { createTrainingDataRulesPublisher } from '~/server/services/feed-go-training-data-rules';

/**
 * feed-go serves a public model body listing a Training Data file only while the live fields of
 * this hash are exactly its own rule set id (apps/feed-go/DESIGN.md §16.8). These pin what each
 * Node process writes there and the key both sides name.
 */

const GO_RULES = path.resolve(
  __dirname,
  '../../../../apps/feed-go/internal/v1models/trainingdata_rules.go'
);

function publisher(start: number) {
  let now = start;
  const writes: [string, number][] = [];
  let fail = false;
  const publish = createTrainingDataRulesPublisher({
    write: (field, ttlMs) => {
      writes.push([field, ttlMs]);
      return fail ? Promise.reject(new Error('down')) : Promise.resolve();
    },
    rulesId: () => 'abc;rules=1',
    now: () => now,
  });
  return {
    publish,
    writes,
    at: (t: number) => (now = t),
    failing: () => (fail = true),
  };
}

describe('feed-go training data rules publisher', () => {
  it("writes this build's rule set id with a 5-minute TTL, at most once a minute", () => {
    const p = publisher(1_000_000);
    p.publish();
    p.publish();
    p.at(1_059_999);
    p.publish();
    expect(p.writes).toEqual([['abc;rules=1', 300_000]]);
    p.at(1_060_000);
    p.publish();
    expect(p.writes).toEqual([
      ['abc;rules=1', 300_000],
      ['abc;rules=1', 300_000],
    ]);
  });

  it('never throws when the write fails, and tries again a minute later', async () => {
    const p = publisher(5_000);
    p.failing();
    expect(() => p.publish()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    p.at(65_000);
    p.publish();
    expect(p.writes).toHaveLength(2);
  });

  it('writes the key feed-go reads', () => {
    // A cross-app pin: feed-go's KeyTrainingDataRulesLive must name this hash.
    expect(REDIS_KEYS.FEED_GO.TRAINING_DATA_RULES_LIVE).toBe('feed-go:training-data-rules-live');
    const go = /^const KeyTrainingDataRulesLive = "([^"]+)"$/m.exec(readFileSync(GO_RULES, 'utf8'));
    expect(go?.[1]).toBe('feed-go:training-data-rules-live');
  });
});
