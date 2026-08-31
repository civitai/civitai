/**
 * The real config with SSR pre-bundling stripped back off the unit projects — i.e. the state
 * `vitest.config.mts` was in before the pre-bundling commit. Exists so a control-vs-control pair
 * can be run against the ORIGINAL control after the change has landed, which is what measures
 * run-to-run drift on this box rather than the change.
 */
import base from '../../vitest.config.mts';

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name?.startsWith('unit')
);
for (const project of projects) {
  const deps: any = { ...project.test.deps };
  delete deps.optimizer;
  project.test.deps = deps;
}
config.test.projects = projects;

export default config;
