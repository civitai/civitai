import { spawnSync } from 'child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The skill reads its own .env first and the repo-root .env second, and the root one names the
// app's local database under the same keys. These run a copy of query.mjs in a scratch tree laid out
// like the repo (root .env, .claude/skills/postgres-query/), placed under node_modules so `pg` still
// resolves. Port 1 refuses connections, so a run that gets past the guard fails without touching a
// database.
const repoRoot = resolve(__dirname, '../..');
const source = join(repoRoot, '.claude/skills/postgres-query/query.mjs');
const LOCAL_URL = 'postgres://app:app@127.0.0.1:1/civitai';

let scratch: string;
let skillDir: string;

const run = (...args: string[]) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/DATABASE|_DB_/.test(key)) delete env[key];
  return spawnSync(process.execPath, [join(skillDir, 'query.mjs'), ...args, 'SELECT 1'], {
    env,
    encoding: 'utf-8',
    timeout: 20_000,
  });
};

beforeEach(() => {
  scratch = join(repoRoot, 'node_modules/.cache/postgres-query-guard', String(process.pid));
  skillDir = join(scratch, '.claude/skills/postgres-query');
  mkdirSync(skillDir, { recursive: true });
  copyFileSync(source, join(skillDir, 'query.mjs'));
  writeFileSync(
    join(scratch, '.env'),
    `DATABASE_REPLICA_URL=${LOCAL_URL}\nDATABASE_URL=${LOCAL_URL}\n`
  );
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe('postgres-query target guard', () => {
  it('refuses --prod when the URL comes from the repo-root .env', () => {
    const result = run('--prod');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `DATABASE_REPLICA_URL for --prod was read from ${join(scratch, '.env')}`
    );
    expect(result.stderr).not.toContain('Target: PROD');
  });

  it('lets the same URL through when it is in the skill .env', () => {
    writeFileSync(join(skillDir, '.env'), `DATABASE_REPLICA_URL=${LOCAL_URL}\n`);

    const result = run('--prod');

    expect(result.stderr).toContain('Target: PROD');
    expect(result.stderr).not.toContain('was read from');
  });
});
