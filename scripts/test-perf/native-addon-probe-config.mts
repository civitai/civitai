/**
 * The real config with the native-addon recorder prepended to the unit project's setupFiles,
 * and both unit projects forced onto `forks` so the run survives whatever it finds.
 *
 * Derived from the real config rather than restating it, same reason as sharp-probe-config.mts.
 */
import path from 'path';
import base from '../../vitest.config.mts';

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name?.startsWith('unit')
);
if (projects.length === 0) throw new Error('no unit projects found');

const probe = path.resolve(import.meta.dirname, 'native-addon-probe-setup.ts');
for (const project of projects) {
  // First, so the hook is installed before any test module graph loads.
  project.test.setupFiles = [probe, ...project.test.setupFiles];
  project.test.pool = 'forks';
}
config.test.projects = projects;

export default config;
