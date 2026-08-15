/**
 * The real config with the unit projects' `deps.inline` dropped, to test whether inlining
 * `@civitai/client` is still load-bearing. The comment on it says "ESM resolution issues";
 * `src/__tests__/setup.ts` also mocks the package wholesale, so the inline may be redundant.
 *
 * Set `KEEP_INLINE_PREBUNDLE=1` to drop the inline AND pre-bundle the package instead, which is
 * the "pre-bundling subsumes the inline" hypothesis rather than the "inline is unnecessary" one.
 * They are different claims and this probe keeps them separable.
 */
import base from '../../vitest.config.mts';

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name?.startsWith('unit')
);
if (projects.length === 0) throw new Error('no unit projects found');

for (const project of projects) {
  const deps: any = { ...project.test.deps };
  delete deps.inline;
  if (process.env.KEEP_INLINE_PREBUNDLE === '1') {
    deps.optimizer = { ssr: { enabled: true, include: ['@civitai/client'] } };
  }
  project.test.deps = deps;
}
config.test.projects = projects;

export default config;
