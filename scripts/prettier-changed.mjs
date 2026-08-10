// Prettier over UNCOMMITTED files only — never the whole repo.
//
// The repo is not Prettier-clean and will not be until the 2->3 upgrade reformats it deliberately
// (see .github/workflows/lint.yml): a repo-wide `prettier --write` rewrites ~1000 committed files,
// burying the actual change and reformatting other people's in-flight work. CI already scopes itself
// to the files a PR touched; this is the local equivalent.
//
// Scope is "what git reports as dirty" — modified-vs-HEAD plus untracked. That is exactly the set a
// commit is about to capture, and it is empty on a clean tree, so running this twice is a no-op.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const mode = process.argv[2] === 'check' ? 'check' : 'write';

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

let files;
try {
  files = [
    ...git(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']),
    ...git(['ls-files', '--others', '--exclude-standard']),
  ];
} catch {
  console.error('prettier-changed: not a git repository (or no HEAD yet).');
  process.exit(1);
}

const targets = [...new Set(files)].filter((f) => /\.(ts|tsx)$/.test(f) && existsSync(f));

if (!targets.length) {
  console.log('prettier-changed: no uncommitted .ts/.tsx files.');
  process.exit(0);
}

// Resolved rather than hardcoded: Prettier 2's entry is bin-prettier.js and 3's is bin/prettier.cjs,
// and the 2->3 upgrade is planned.
const require = createRequire(import.meta.url);
const pkgPath = require.resolve('prettier/package.json');
const pkgBin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin;
const bin = resolve(dirname(pkgPath), typeof pkgBin === 'string' ? pkgBin : pkgBin.prettier);

// Chunked: a large branch can exceed the command-line length limit, and Windows' is the shortest.
let failed = false;
for (let i = 0; i < targets.length; i += 100) {
  const { status } = spawnSync('node', [bin, `--${mode}`, ...targets.slice(i, i + 100)], {
    stdio: 'inherit',
  });
  if (status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
