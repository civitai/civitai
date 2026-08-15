// Records that the REAL @civitai/client module body evaluated. If setup.ts's wholesale
// vi.mock intercepts every request, this file never runs and the load count is zero — which
// is what makes "removing deps.inline still passes" a vacuous result rather than a finding.
import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';

const repoRoot = path.resolve(import.meta.dirname, '../..');
mkdirSync(path.join(repoRoot, '.test-perf'), { recursive: true });
appendFileSync(path.join(repoRoot, '.test-perf/civitai-client-loads.jsonl'), JSON.stringify({ at: 'module-body' }) + '\n');

const require = createRequire(import.meta.url);
export default require(path.join(repoRoot, 'node_modules/@civitai/client/dist/index.js'));
