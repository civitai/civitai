/**
 * The root config with `sharp` aliased to scripts/test-perf/sharp-usage-probe.mjs, so a run
 * records which test files execute a libvips operation. Runs under `forks`, which survives.
 *
 * Derived from the real config rather than restating it — the `unit` project's alias list is
 * load-bearing (nine workspace packages that fail to COLLECT without it), and a hand-copied
 * version would rot silently.
 */
import path from 'path';
import base from '../../vitest.config.mts';

const sharpAlias = {
  find: /^sharp$/,
  replacement: path.resolve(import.meta.dirname, 'sharp-usage-probe.mjs'),
};

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name === 'unit'
);
if (projects.length !== 1) {
  throw new Error(`expected exactly one 'unit' project, found ${projects.length}`);
}
// Must precede the `~` entry so it wins, same ordering rule the componentAlias follows.
projects[0].resolve.alias = [sharpAlias, ...projects[0].resolve.alias];
config.test.projects = projects;

export default config;
