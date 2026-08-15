import { describe, expect, it } from 'vitest';

// The wrapper `pnpm run test:unit:run` now points at. Imported by path for the same reason the
// dev-server probes are: it runs under plain node and is never bundled.
import { queueDecision } from '../test-unit-run.mjs';

// The flag is what keeps this change invisible to CI and to anyone who does not run the daemon.
// If any of these flip, a shared script starts behaving differently for people who never opted in.
describe('test:unit:run — when the queue is used', () => {
  it('runs directly when the flag is unset, which is everyone by default', () => {
    expect(queueDecision([], {}).queue).toBe(false);
    expect(queueDecision([], {}).why).toMatch(/not set/);
  });

  it('runs directly in CI even with the flag set', () => {
    expect(queueDecision([], { CI: 'true', CIVITAI_TEST_QUEUE: '1' }).queue).toBe(false);
    expect(queueDecision([], { CI: 'true', CIVITAI_TEST_QUEUE: '1' }).why).toMatch(/CI/);
  });

  it('treats the usual off-values as off, not as "set"', () => {
    for (const value of ['0', 'false', 'off', 'no', 'FALSE', '']) {
      expect(queueDecision([], { CIVITAI_TEST_QUEUE: value }).queue).toBe(false);
    }
  });

  it('queues a bare full-suite run when the flag is on', () => {
    expect(queueDecision([], { CIVITAI_TEST_QUEUE: '1' }).queue).toBe(true);
    expect(queueDecision(['--reporter=dot'], { CIVITAI_TEST_QUEUE: '1' }).queue).toBe(true);
  });

  it('runs a file-scoped request directly — the fast loop must not queue behind a full suite', () => {
    const env = { CIVITAI_TEST_QUEUE: '1' };
    expect(queueDecision(['scripts/__tests__/a.test.ts'], env).queue).toBe(false);
    expect(queueDecision(['src/b.spec.tsx'], env).queue).toBe(false);
    expect(queueDecision(['--reporter=dot', 'src/c.test.mts'], env).queue).toBe(false);
  });

  it('does not mistake a flag value or a directory for a test file', () => {
    const env = { CIVITAI_TEST_QUEUE: '1' };
    // A trailing slash is a directory, and `--exclude '**/*.test.ts'` is a glob, not a target.
    expect(queueDecision(['--dir', 'src/x.test.ts/'], env).queue).toBe(true);
    expect(queueDecision(['--reporter=verbose'], env).queue).toBe(true);
  });
});
