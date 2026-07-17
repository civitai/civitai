import { afterAll, describe, expect, it } from 'vitest';
import { deleteChatMemberForUser, deleteChatMessageForUser } from './chat.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` (so writes compile but never execute), then EXPLAIN the compiled
// SQL against the live schema. Validates that every ported query's columns/joins/types/enums resolve. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('chat queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  const simpleDeletes: Array<[string, () => Promise<unknown>]> = [
    ['deleteChatMessageForUser', () => deleteChatMessageForUser(h.db, -1)],
    ['deleteChatMemberForUser', () => deleteChatMemberForUser(h.db, -1)],
  ];

  it.each(simpleDeletes)('%s plans', async (_name, fn) => {
    await fn();
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
