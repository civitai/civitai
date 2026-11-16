import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Ledger of every nodemailer `createTransport(` call site in the repo outside tests. There must be
// exactly one, in @civitai/email, so the timeouts it sets apply to every app that sends mail. A
// second transport was how the main app kept sending without timeouts after they were added to the
// package. Adding a call site, or removing this one, fails here: route new senders through
// @civitai/email (or ~/server/email/client in the main app) and update the ledger only on purpose.
const EXPECTED = ['packages/civitai-email/src/client.ts: 1'];

const ROOT = path.resolve(__dirname, '../../..');
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
    scan(ROOT, found, seen);
    // The walk must actually have covered the repo, or an empty result would be meaningless.
    expect(seen.files).toBeGreaterThan(1000);
    expect(found.sort()).toEqual(EXPECTED);
  }, 60_000);
});
