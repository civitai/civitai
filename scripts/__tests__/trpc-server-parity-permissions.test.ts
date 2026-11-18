import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// `tRPC server parity` (.github/workflows/trpc-server-parity.yml) runs a deployed commit's code,
// and a branch's copy of the workflow can run on `deployment_status`. Two properties bound what
// that code can do, and nothing else checks them: its token is minimal, and it reads no
// repository secret. (Trimmed from trpc-server-parity-trigger.test.ts, #9120; the trigger and
// gate pins were dropped as restatements of the workflow text.)

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../../.github/workflows/trpc-server-parity.yml');
const text = readFileSync(FILE, 'utf8');

type Job = { permissions?: Record<string, string> };
const wf = parse(text) as { permissions?: Record<string, string>; jobs: Record<string, Job> };

describe('trpc-server-parity token and secrets', () => {
  it('token permissions are exactly the minimal set', () => {
    expect(wf.permissions).toEqual({ contents: 'read', packages: 'read' });
    expect(
      Object.fromEntries(
        Object.entries(wf.jobs).map(([name, job]) => [name, job.permissions ?? null])
      )
    ).toEqual({
      gate: null,
      parity: { contents: 'read', packages: 'read', statuses: 'write' },
    });
  });

  it('the workflow reads no repository secret', () => {
    expect(text).not.toMatch(/secrets\./);
  });
});
