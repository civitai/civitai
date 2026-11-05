import type { HookPool } from './pool.ts';
import type { HookResult } from './result.ts';

/**
 * Built-in hooks `/readyz` evaluates through the real pool. Ready means the WASM loads in a
 * worker AND the three behaviours a write path depends on hold right now: an allow, a deny with
 * its reason intact, and an infinite loop stopped by the INTERRUPT HANDLER (not the backstop,
 * which would also answer `timeout` and so must not satisfy this check).
 */
const INPUT = JSON.stringify({
  op: 'create',
  collection: 'selftest',
  key: 'k',
  before: null,
  after: { n: 1 },
  doc: null,
  tally: null,
  viewer: { userId: 0 },
  app: { blockId: 'selftest' },
  from: null,
});

type SelfTest = { name: string; source: string; timeoutMs: number; ok: (r: HookResult) => boolean };

export const SELF_TESTS: SelfTest[] = [
  {
    name: 'allow',
    source:
      'export default function check(i) { return i.after.n === 1 ? { allow: true } : { allow: false, reason: "x" }; }',
    timeoutMs: 50,
    ok: (r) => r.allow,
  },
  {
    name: 'deny',
    source:
      'export default function check(i) { return { allow: false, reason: "self-test " + i.op }; }',
    timeoutMs: 50,
    ok: (r) => !r.allow && r.cause === 'denied' && r.reason === 'self-test create',
  },
  {
    name: 'interrupt',
    source: 'export default function check() { for (;;) {} }',
    timeoutMs: 5,
    ok: (r) => !r.allow && r.cause === 'timeout' && r.detail === 'interrupted at the deadline',
  },
];

export type SelfTestReport = { ok: boolean; checks: Record<string, boolean> };

export async function runSelfTest(pool: HookPool): Promise<SelfTestReport> {
  const checks: Record<string, boolean> = {};
  if (pool.stats().ready === 0) return { ok: false, checks: { workers: false } };
  for (const t of SELF_TESTS) {
    try {
      const { result } = await pool.run({
        source: t.source,
        inputJson: INPUT,
        timeoutMs: t.timeoutMs,
      });
      checks[t.name] = t.ok(result);
    } catch {
      checks[t.name] = false;
    }
  }
  return { ok: Object.values(checks).every(Boolean), checks };
}
