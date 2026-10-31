/**
 * Guard proofs for `scripts/ci/app-suite-scope.mjs`, which lets a pull_request run of
 * `.github/workflows/apps.yml` leave the moderator suite out when nothing it reads changed, and for
 * `checkDeclaredSkips`, which the suites ledger runs before it excuses a suite that did not run.
 *
 * Each way the scope derives an input (package.json, an import, a `../` path, transitively) is
 * driven against a throwaway repo where the input is reachable ONLY that way, so a derivation that
 * silently finds nothing leaves the suite out and fails here.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
  appInputs,
  checkDeclaredSkips,
  decide,
  vitestProjectArgs,
} from '../ci/app-suite-scope.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const pkg = (name: string, deps: Record<string, string> = {}) =>
  JSON.stringify({ name, dependencies: deps });

function makeRepo(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-suite-scope-'));
  roots.push(root);
  const all: Record<string, string> = {
    'package.json': pkg('root'),
    'apps/moderator/package.json': pkg('@x/moderator-app'),
    'apps/moderator/vitest.config.ts': '',
    'apps/moderator/src/a.ts': '',
    'apps/other/package.json': pkg('@x/other-app'),
    'apps/other/vitest.config.ts': '',
    'apps/other/src/a.ts': '',
    'apps/no-tests/package.json': pkg('@x/no-tests'),
    'packages/unrelated/package.json': pkg('@x/unrelated'),
    'packages/unrelated/index.ts': '',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const runs = (root: string, changed: string[]) => decide(root, changed).moderator.run;

describe('app-suite-scope: decide', () => {
  it('leaves moderator out when only another app and an unrelated package changed', () => {
    const root = makeRepo();
    expect(runs(root, ['apps/other/src/a.ts', 'packages/unrelated/index.ts'])).toBe(false);
  });

  it('runs moderator when a file of its own changed', () => {
    expect(runs(makeRepo(), ['apps/other/src/a.ts', 'apps/moderator/src/a.ts'])).toBe(true);
  });

  it('runs moderator for any file outside apps/ and packages/', () => {
    const root = makeRepo();
    for (const file of ['pnpm-lock.yaml', 'package.json', 'vitest.config.mts', 'scripts/x.mjs']) {
      expect(runs(root, ['apps/other/src/a.ts', file])).toBe(true);
    }
  });

  it('runs moderator for a loose file under packages/ that is in no member', () => {
    expect(runs(makeRepo(), ['packages/README.md'])).toBe(true);
  });

  it('runs everything when there is nothing to reason from', () => {
    expect(runs(makeRepo(), [])).toBe(true);
  });

  it('follows a workspace dependency declared in package.json', () => {
    const files = {
      'apps/moderator/package.json': pkg('@x/moderator-app', { '@x/schema': 'workspace:*' }),
      'packages/schema/package.json': pkg('@x/schema'),
      'packages/schema/s.prisma': '',
    };
    expect(runs(makeRepo(files), ['packages/schema/s.prisma'])).toBe(true);
    // Control: the same package, not declared, is not an input.
    const undeclared = { ...files, 'apps/moderator/package.json': pkg('@x/moderator-app') };
    expect(runs(makeRepo(undeclared), ['packages/schema/s.prisma'])).toBe(false);
  });

  it('follows dependencies transitively', () => {
    const files = {
      'apps/moderator/package.json': pkg('@x/moderator-app', { '@x/db': 'workspace:*' }),
      'packages/db/package.json': pkg('@x/db', { '@x/schema': 'workspace:^' }),
      'packages/schema/package.json': pkg('@x/schema'),
      'packages/schema/s.ts': '',
    };
    expect(runs(makeRepo(files), ['packages/schema/s.ts'])).toBe(true);
  });

  it('follows an import of a workspace package the app never declared', () => {
    const files = {
      'apps/moderator/src/a.ts': "import { x } from '@x/schema/sub';",
      'packages/schema/package.json': pkg('@x/schema'),
      'packages/schema/s.ts': '',
    };
    expect(runs(makeRepo(files), ['packages/schema/s.ts'])).toBe(true);
  });

  it('follows a ../ path into another member', () => {
    const files = {
      'apps/moderator/src/t.test.ts':
        "readFileSync(join(HERE, '../../../packages/schema/migrations/1/migration.sql'))",
      'packages/schema/package.json': pkg('@x/schema'),
      'packages/schema/migrations/1/migration.sql': '',
    };
    expect(runs(makeRepo(files), ['packages/schema/migrations/1/migration.sql'])).toBe(true);
  });

  it('does not treat a non-workspace dependency as a member', () => {
    const files = {
      'apps/moderator/package.json': pkg('@x/moderator-app', { '@x/unrelated': '^1.0.0' }),
    };
    expect(runs(makeRepo(files), ['packages/unrelated/index.ts'])).toBe(false);
  });
});

describe('app-suite-scope: vitestProjectArgs', () => {
  it('selects app:* when nothing is left out, as the job did before', () => {
    expect(vitestProjectArgs(makeRepo(), [])).toEqual(['--project=app:*']);
  });

  it('names every app with a vitest config except the ones left out', () => {
    expect(vitestProjectArgs(makeRepo(), ['moderator'])).toEqual(['--project=app:other']);
  });
});

describe('app-suite-scope: checkDeclaredSkips', () => {
  const root = makeRepo();
  const sound = { event: 'pull_request', changed: ['apps/other/src/a.ts'], skipped: ['moderator'] };

  it('accepts a skip that re-derives the same way on a pull_request run', () => {
    expect(checkDeclaredSkips(root, sound, ['other'], 'pull_request')).toEqual([]);
  });

  it('has nothing to check when nothing was left out', () => {
    const scope = { ...sound, skipped: [] };
    expect(checkDeclaredSkips(root, scope, ['other'], 'push')).toEqual([]);
  });

  it('rejects a skip on a run that is not a pull_request', () => {
    expect(checkDeclaredSkips(root, sound, ['other'], 'push')).toEqual([
      expect.stringContaining('only pull_request runs are scoped'),
    ]);
    const scope = { ...sound, event: 'workflow_dispatch' };
    expect(checkDeclaredSkips(root, scope, ['other'], 'pull_request')).toEqual([
      expect.stringContaining('only pull_request runs are scoped'),
    ]);
  });

  it('rejects a skip its own changed files do not lead to', () => {
    const scope = { ...sound, changed: ['apps/moderator/src/a.ts'] };
    expect(checkDeclaredSkips(root, scope, ['other'], 'pull_request')).toEqual([
      expect.stringContaining('its own changed files leave out []'),
    ]);
  });

  it('rejects a skip of an app that ran anyway', () => {
    expect(checkDeclaredSkips(root, sound, ['other', 'moderator'], 'pull_request')).toEqual([
      expect.stringContaining('moderator was declared left out but ran'),
    ]);
  });

  it('rejects leaving out an app that is not scoped', () => {
    const scope = { ...sound, skipped: ['moderator', 'other'] };
    expect(checkDeclaredSkips(root, scope, [], 'pull_request')).toContainEqual(
      'other is not an app a PR may leave out'
    );
  });
});

describe('app-suite-scope on this repository', () => {
  it('derives moderator inputs that include its schema package', () => {
    expect(appInputs(REPO, 'apps/moderator').has('packages/civitai-db-schema')).toBe(true);
  });

  it('leaves moderator out for a change confined to another app, and runs it for its schema', () => {
    expect(decide(REPO, ['apps/auth/package.json']).moderator.run).toBe(false);
    expect(
      decide(REPO, ['apps/auth/package.json', 'packages/civitai-db-schema/package.json']).moderator
        .run
    ).toBe(true);
  });
});
