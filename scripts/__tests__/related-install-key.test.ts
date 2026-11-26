import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  cachePaths,
  manifestKeyText,
  memberDirs,
  missingCachePaths,
  parseWorkspace,
} from '../ci/related-install-key.mjs';

// scripts/ci/related-install-key.mjs feeds the related jobs' installed-tree cache key (lint.yml).
// Two ways it can go wrong silently: a key that changes on every release bump (a miss on every PR,
// a new entry per bump), or a cached path list that misses a workspace include (a hit restores a
// tree without that include's node_modules).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

type Step = { id?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const lint = parse(read('.github/workflows/lint.yml')) as {
  jobs: Record<string, { steps?: Step[] }>;
};
const restoreStep = (job: string) =>
  (lint.jobs[job]?.steps ?? []).find(
    (s) => s.id === 'nm' && String(s.uses).startsWith('actions/cache/')
  );

describe('manifestKeyText', () => {
  const m = (dir: string, manifest: Record<string, unknown>) => ({ dir, manifest });

  // The point of the key: a release bump is not an install change. Mutant: keep `version`, and
  // the two texts differ (killed).
  it('ignores `version` and key order', () => {
    expect(
      manifestKeyText([
        m('apps/knights', { version: '0.0.25', name: 'knights', dependencies: { a: '1' } }),
      ])
    ).toBe(
      manifestKeyText([
        m('apps/knights', { dependencies: { a: '1' }, name: 'knights', version: '0.0.26' }),
      ])
    );
  });

  // The positive control: a dependency change still changes the key.
  it('changes with a dependency, a script or a new member', () => {
    const base = manifestKeyText([m('.', { name: 'root', dependencies: { a: '1' } })]);
    expect(manifestKeyText([m('.', { name: 'root', dependencies: { a: '2' } })])).not.toBe(base);
    expect(
      manifestKeyText([
        m('.', { name: 'root', dependencies: { a: '1' }, scripts: { postinstall: 'x' } }),
      ])
    ).not.toBe(base);
    expect(
      manifestKeyText([
        m('.', { name: 'root', dependencies: { a: '1' } }),
        m('apps/new', { name: 'new' }),
      ])
    ).not.toBe(base);
  });
});

describe('the workspace members', () => {
  const ws = parseWorkspace(
    "packages:\n  - '.'\n  - 'apps/*'\n  # a Go module\n  - '!apps/feed-go'\n"
  );

  it('reads includes and excludes', () => {
    expect(ws).toEqual({ includes: ['.', 'apps/*'], excludes: ['apps/feed-go'] });
  });

  // An excluded package is never installed, so its manifest (a release version only) stays out.
  it('drops the excluded dirs', () => {
    expect(memberDirs('/r', ws, () => ['auth', 'feed-go'])).toEqual(['.', 'apps/auth']);
  });

  it('refuses a packages pattern it cannot expand', () => {
    expect(() => memberDirs('/r', parseWorkspace("packages:\n  - 'apps/**'\n"), () => [])).toThrow(
      /unsupported packages pattern: apps\/\*\*/
    );
  });
});

// F2: the cached paths must cover every workspace include, or a hit restores a tree with a
// member's node_modules missing.
describe('lint.yml caches every include of pnpm-workspace.yaml', () => {
  const listed = (job: string) => String(restoreStep(job)?.with?.path ?? '').split('\n');

  it.each(['related-tests', 'related-cache'])(
    '%s: the cached paths cover the real includes',
    (job) => {
      const ws = parseWorkspace(read('pnpm-workspace.yaml'));
      expect(ws.includes.length).toBeGreaterThan(0);
      expect(missingCachePaths(ws, listed(job))).toEqual([]);
    }
  );

  // The guard, shown failing: a new include in a fixture workspace file is reported missing.
  it('names an include the cached paths miss', () => {
    const ws = parseWorkspace(
      `${read('pnpm-workspace.yaml')}\n  - 'tools/*'\n`.replace(/\n\n/g, '\n')
    );
    expect(ws.includes).toContain('tools/*');
    expect(missingCachePaths(ws, listed('related-tests'))).toEqual(['tools/*/node_modules']);
  });

  it('cachePaths maps the root to node_modules and a dir glob to its node_modules', () => {
    expect(cachePaths({ includes: ['.', 'packages/*'] })).toEqual([
      'node_modules',
      'packages/*/node_modules',
    ]);
  });

  // The key hashes the script's output and the workspace file, not the raw manifests, and both
  // jobs compute it with the same step.
  it.each(['related-tests', 'related-cache'])(
    '%s: the key hashes the stripped manifests',
    (job) => {
      const key = String(restoreStep(job)?.with?.key ?? '');
      expect(key).toContain("'.related-install-manifests.txt'");
      expect(key).toContain("'pnpm-workspace.yaml'");
      expect(key).not.toMatch(/package\.json/);
      expect(key).toContain('steps.key.outputs.image');
      const keyStep = (lint.jobs[job]?.steps ?? []).find((s) => s.id === 'key');
      expect(keyStep?.run).toContain(
        'node scripts/ci/related-install-key.mjs .related-install-manifests.txt'
      );
    }
  );
});
