import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every call that issues a generation token to a restricted account. Each one must keep the token on
// the server and never submit work: it reads, deletes or cancels the account's own workflows, or is a
// moderator acting on them (publishing stamps workflow metadata).
// Adding one here is a review decision, not a test fix: check both before you add it.
const ALLOWED = {
  'src/server/routers/orchestrator.router.ts': {
    // the middleware's option, orchestratorOwnWorkProcedure, and the moderator read of another account
    allowRestricted: 3,
    procedures: [
      'cancelWorkflow',
      'deleteWorkflow',
      'getWorkflow',
      'queryGeneratedImages',
      'queryWorkflowsByTags',
    ],
  },
  'src/server/services/orchestrator/poll-iteration.ts': { allowRestricted: 1, procedures: [] },
  // The retention job's read of a run, for an owner who may since have been restricted.
  'src/server/services/orchestrator/training/studio-dataset-archive.service.ts': {
    allowRestricted: 1,
    procedures: [],
  },
  // Reads of the account's own training runs.
  'src/server/services/orchestrator/training/training-state.ts': {
    allowRestricted: 2,
    procedures: [],
  },
  // Only for another account's run (callerId !== ownerId): a moderator publishing or moving it.
  'src/server/services/orchestrator/training/approved-checkpoint.ts': {
    allowRestricted: 1,
    procedures: [],
  },
  'src/server/services/orchestrator/training/publish-from-workflow.ts': {
    allowRestricted: 2,
    procedures: [],
  },
} as Record<string, { allowRestricted: number; procedures: string[] }>;

const root = join(__dirname, '../../../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('generation tokens issued to restricted accounts', () => {
  const found: Record<string, { allowRestricted: number; procedures: string[] }> = {};
  const definition = 'src/server/orchestrator/get-orchestrator-token.ts';
  for (const file of sourceFiles(join(root, 'src'))) {
    if (relative(root, file).replaceAll('\\', '/') === definition) continue;
    const text = readFileSync(file, 'utf8');
    // Every mention, in any form (shorthand, a variable, a spread), not only `allowRestricted: true`.
    const allowRestricted = text.match(/\ballowRestricted\b/g)?.length ?? 0;
    const procedures = [...text.matchAll(/(\w+):\s*orchestratorOwnWorkProcedure\b/g)]
      .map((m) => m[1])
      .sort();
    if (allowRestricted || procedures.length)
      found[relative(root, file).replaceAll('\\', '/')] = { allowRestricted, procedures };
  }

  it('come only from the reviewed call sites', () => {
    expect(found).toEqual(ALLOWED);
  });
});
