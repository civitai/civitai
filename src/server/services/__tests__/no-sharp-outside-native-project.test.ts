import { existsSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import config from '../../../../vitest.config.mts';

/**
 * `sharp` 0.32.6 segfaults a `worker_threads` worker at teardown once it has run a libvips
 * operation, which is why the six test files that call it are routed to their own `forks`
 * project. The failure has no failing test attached to it — the suite passes, the summary
 * prints, and then the process dies on an exit code — so nothing else in the suite notices
 * when the routing breaks.
 *
 * The realistic way it breaks is a rename: the path stops matching `unit-native`'s `include`
 * AND stops matching `unit`'s `exclude`, so the file silently rejoins the threads pool.
 */
const repoRoot = path.resolve(__dirname, '../../../..');
const projects = (config as any).test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name
);
const projectNamed = (name: string) => projects.find((p: any) => p.test.name === name);

describe('native-addon pool split', () => {
  it('routes the sharp files to a process-based pool', () => {
    const native = projectNamed('unit-native');
    expect(native.test.pool).toBe('forks');
    expect(native.test.include.length).toBeGreaterThan(0);
  });

  it('keeps every routed file on disk', () => {
    const native = projectNamed('unit-native');
    const missing = native.test.include.filter(
      (file: string) => !existsSync(path.join(repoRoot, file))
    );
    expect(missing).toEqual([]);
  });

  it('excludes every routed file from the threads project', () => {
    const unit = projectNamed('unit');
    expect(unit.test.pool).toBe('threads');
    const native = projectNamed('unit-native');
    const notExcluded = native.test.include.filter(
      (file: string) => !unit.test.exclude.includes(file)
    );
    expect(notExcluded).toEqual([]);
  });
});
