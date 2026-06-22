import { describe, expect, it } from 'vitest';

// During the PR #2697 follow-up sweep, several sysRedis.hGet callers were
// audited but NOT changed because their only post-read op is `JSON.parse`,
// which accepts a Buffer in Node ≥18 (we run Node 20 — see Dockerfile).
// This unit test is a load-bearing invariant: if the Node version policy
// ever changes, this test fails and the affected sites must be coerced too.
//
// Affected (unfixed) sites that rely on this behavior:
//   - src/server/services/training.service.ts:267,287
//   - src/server/services/generation/generation.service.ts:251,272,315
//   - src/server/services/orchestrator/common.ts:99
//   - src/server/services/orchestrator/orchestration-new.service.ts:227
//   - src/server/jobs/rewards-abuse-prevention.ts:19
//   - src/server/jobs/entity-moderation.ts:283,291
//   - src/server/routers/buzz-withdrawal-request.router.ts:50
//   - src/server/controllers/buzz-withdrawal-request.controller.ts:33

describe('JSON.parse(Buffer) — Node ≥18 invariant', () => {
  it('accepts a Buffer payload (mirrors what sentinel-mode sysRedis returns)', () => {
    const parsed = JSON.parse(Buffer.from('{"available":true,"message":null}', 'utf8'));
    expect(parsed).toEqual({ available: true, message: null });
  });

  it('round-trips the shape used by getTrainingServiceStatus / getGenerationStatus', () => {
    const original = { mode: 'enabled', message: null, charge: true };
    const buf = Buffer.from(JSON.stringify(original), 'utf8');
    expect(JSON.parse(buf)).toEqual(original);
  });
});
