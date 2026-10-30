import path from 'path';
import base from '../../vitest.config.mts';

const config = base as any;
const projects = config.test.projects.filter(
  (p: any) => typeof p === 'object' && p.test?.name?.startsWith('unit')
);
const probe = {
  find: /^@civitai\/client$/,
  replacement: path.resolve(import.meta.dirname, 'civitai-client-load-probe.mjs'),
};
for (const project of projects) {
  project.resolve.alias = [probe, ...project.resolve.alias];
}
config.test.projects = projects;
export default config;
