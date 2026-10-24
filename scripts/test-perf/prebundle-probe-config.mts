/**
 * The real config with SSR dependency pre-bundling turned on for the unit projects.
 *
 * Every test file is a fresh module registry, so each one pays the cold import of every
 * node_modules package it reaches. Pre-bundling collapses a package's many-hundred-file native
 * load into one chunk, which is why it is worth measuring — but the thing that decides whether it
 * is usable at all is whether `vi.mock` of an externalised dependency still intercepts, and this
 * repo has ~3,883 mock sites.
 *
 * `PREBUNDLE_INCLUDE` overrides the package list (comma-separated) so a single suspect can be
 * tested alone.
 */
import base from '../../vitest.config.mts';

// The heavy-fan-in packages: cold-import cost x how many test files reach them.
const DEFAULT_INCLUDE = [
  'lodash-es',
  'redis',
  'googleapis',
  '@tiptap/html',
  '@axiomhq/axiom-node',
  '@aws-sdk/client-s3',
  '@aws-sdk/lib-storage',
  '@aws-sdk/s3-request-presigner',
];

const include = (process.env.PREBUNDLE_INCLUDE ?? DEFAULT_INCLUDE.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name?.startsWith('unit')
);
if (projects.length === 0) throw new Error('no unit projects found');

for (const project of projects) {
  project.test.deps = {
    ...project.test.deps,
    optimizer: { ssr: { enabled: true, include } },
  };
}
config.test.projects = projects;

export default config;
