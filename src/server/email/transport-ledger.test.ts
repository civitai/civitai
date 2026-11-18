import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// One createTransport call site, in @civitai/email, so its timeouts reach every sender. Route new
// senders through it (or ~/server/email/client); edit EXPECTED only on purpose.
const EXPECTED = ['packages/civitai-email/src/client.ts: 1'];

const ROOT = path.resolve(__dirname, '../../..');
// The directories that hold app and package code. Walking ROOT itself would also walk nested
// worktrees under .claude/worktrees and count their copy of the real call site.
const SOURCE_ROOTS = ['src', 'apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.svelte-kit',
  '.vercel',
  'dist',
  'build',
  'coverage',
  'out',
  'storybook-static',
  'playwright-report',
  'test-results',
  '__tests__',
  '__mocks__',
]);
const SOURCE = /\.(?:[cm]?[jt]sx?|svelte)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CALL = /\bcreateTransport\s*\(/g;

function scan(dir: string, out: string[], seen: { files: number }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scan(full, out, seen);
      continue;
    }
    if (!entry.isFile() || !SOURCE.test(entry.name) || TEST_FILE.test(entry.name)) continue;
    seen.files++;
    const count = readFileSync(full, 'utf8').match(CALL)?.length ?? 0;
    if (count) out.push(`${path.relative(ROOT, full).split(path.sep).join('/')}: ${count}`);
  }
}

describe('nodemailer transport ledger', () => {
  it('has exactly one createTransport call site outside tests', () => {
    const found: string[] = [];
    const seen = { files: 0 };
    for (const dir of SOURCE_ROOTS) scan(path.join(ROOT, dir), found, seen);
    // The walk must actually have covered the repo, or an empty result would be meaningless.
    expect(seen.files).toBeGreaterThan(1000);
    expect(found.sort()).toEqual(EXPECTED);
  }, 60_000);
});
