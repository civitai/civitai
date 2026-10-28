import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs from the dev-server skill, no types
import { appEnvSkipLines, syncAppEnv } from '../../.claude/skills/dev-server/scripts/app-env.mjs';

// `wt env <tree> --refresh` once decided by mtime: a tree file newer than the primary's was kept,
// so a key changed in the primary never reached a tree created (or touched) after it. These pin
// the rule that replaced it: a tree file is skipped only when it differs from what the last copy
// wrote, and `--force` overwrites even that. Every value here is a dummy.

const AUTH = 'apps/auth/.env';
const ROOT_ENV = 'DATABASE_URL=postgresql://dev:dev@localhost:5432/dummy\n';

let dir: string;
let primary: string;
let tree: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const read = (root: string, rel: string) => readFileSync(join(root, rel), 'utf8');
const write = (root: string, rel: string, text: string) => writeFileSync(join(root, rel), text);
/** Push a file's mtime into the future, so mtime alone would call it newer than the primary's. */
const touchNewer = (root: string, rel: string) => {
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, rel), later, later);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'app-env-refresh-'));
  primary = join(dir, 'primary');
  tree = join(dir, 'tree');
  mkdirSync(join(primary, 'apps/auth'), { recursive: true });
  git(primary, 'init', '-q', '-b', 'main');
  write(primary, '.gitignore', '.env\n');
  write(primary, 'apps/auth/README.md', 'auth\n');
  git(primary, 'add', '.gitignore', 'apps/auth/README.md');
  git(primary, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  git(primary, 'worktree', 'add', '-q', '-b', 'tree', tree);
  write(primary, '.env', ROOT_ENV);
  write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=old-dummy\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wt env --refresh', () => {
  it('(1) refreshes a tree file that is newer than the primary but unedited', () => {
    expect(syncAppEnv(primary, tree).copied).toContain(AUTH);
    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=new-dummy\n');
    touchNewer(tree, AUTH);

    const r = syncAppEnv(primary, tree, { refresh: true });

    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=new-dummy\n');
    expect(r.refreshed).toContain(AUTH);
  });

  it('(2) skips a tree file with a local edit, and the skip line names --force', () => {
    syncAppEnv(primary, tree);
    write(tree, AUTH, 'AUTH_INTERNAL_TOKEN=old-dummy\nLOCAL_ONLY=1\n');
    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=new-dummy\n');
    touchNewer(primary, AUTH);

    const r = syncAppEnv(primary, tree, { refresh: true });

    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=old-dummy\nLOCAL_ONLY=1\n');
    expect(r.edited).toEqual([AUTH]);
    expect(r.refreshed).not.toContain(AUTH);
    expect(appEnvSkipLines(r)).toEqual([
      `  skipped   ${AUTH} (edited in this tree since the last refresh; --force overwrites it)`,
    ]);
  });

  it('(3) --force overwrites a tree file with a local edit, and the next refresh sees it as unedited', () => {
    syncAppEnv(primary, tree);
    write(tree, AUTH, 'AUTH_INTERNAL_TOKEN=old-dummy\nLOCAL_ONLY=1\n');
    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=new-dummy\n');

    const r = syncAppEnv(primary, tree, { refresh: true, force: true });

    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=new-dummy\n');
    expect(r.refreshed).toContain(AUTH);
    expect(r.edited).toEqual([]);

    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=newer-dummy\n');
    touchNewer(tree, AUTH);
    syncAppEnv(primary, tree, { refresh: true });
    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=newer-dummy\n');
  });

  it('(first run) with no record, a file that differs is left alone; one that matches is recorded', () => {
    // A tree copied before the record existed: its files were written, but nothing noted what.
    write(tree, '.env', ROOT_ENV);
    write(tree, AUTH, 'AUTH_INTERNAL_TOKEN=stale-dummy\n');
    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=new-dummy\n');
    touchNewer(primary, AUTH);

    const r = syncAppEnv(primary, tree, { refresh: true });

    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=stale-dummy\n');
    expect(r.unrecorded).toEqual([AUTH]);
    expect(r.edited).toEqual([]);
    expect(appEnvSkipLines(r)).toEqual([
      `  skipped   ${AUTH} (no refresh record yet and it differs from the primary; --force overwrites it)`,
    ]);

    // The root .env matched the primary, so it was recorded: a later primary edit now reaches it
    // even though the tree's copy is newer.
    write(primary, '.env', `${ROOT_ENV}SOME_DUMMY_KEY=2\n`);
    touchNewer(tree, '.env');
    syncAppEnv(primary, tree, { refresh: true });
    expect(read(tree, '.env')).toBe(`${ROOT_ENV}SOME_DUMMY_KEY=2\n`);
  });

  it('without --refresh, an existing tree file is left alone', () => {
    syncAppEnv(primary, tree);
    write(primary, AUTH, 'AUTH_INTERNAL_TOKEN=new-dummy\n');

    const r = syncAppEnv(primary, tree);

    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=old-dummy\n');
    expect(r.kept).toContain(AUTH);

    // That pass must not have recorded the primary's new text as what the tree holds.
    expect(syncAppEnv(primary, tree, { refresh: true }).refreshed).toContain(AUTH);
    expect(read(tree, AUTH)).toBe('AUTH_INTERNAL_TOKEN=new-dummy\n');
  });
});
