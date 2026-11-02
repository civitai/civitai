import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every call that issues a generation token to a restricted account. Each one must keep the token on
// the server and only read, delete or cancel the account's own work, or be a moderator's read of it.
// Adding one here is a review decision, not a test fix: check both before you add it.
const ALLOWED = {
  'src/server/routers/orchestrator.router.ts': {
    allowRestricted: 2, // orchestratorOwnWorkProcedure, and the moderator read of another account
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
  for (const file of sourceFiles(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const allowRestricted = text.match(/allowRestricted:\s*true/g)?.length ?? 0;
    const procedures = [...text.matchAll(/^\s*(\w+):\s*orchestratorOwnWorkProcedure\b/gm)]
      .map((m) => m[1])
      .sort();
    if (allowRestricted || procedures.length)
      found[relative(root, file).replaceAll('\\', '/')] = { allowRestricted, procedures };
  }

  it('come only from the reviewed call sites', () => {
    expect(found).toEqual(ALLOWED);
  });
});
