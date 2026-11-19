import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * One copy of `@civitai/orchestration-client` in the install, the version the root `package.json`
 * names. A dependency that pins its own version (as `@civitai/sdk` did before 0.24.0) adds a second
 * copy: its types are not the app's, and both sets load into every typecheck.
 */
const ROOT = path.resolve(__dirname, '../..');
const PKG = '@civitai/orchestration-client';

const lock = fs.readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
const resolved = [
  ...new Set(
    [...lock.matchAll(/^ {2}'@civitai\/orchestration-client@([^'(]+)[^']*':$/gm)].map((m) => m[1])
  ),
];

describe(`${PKG} resolves to a single version`, () => {
  it('the lockfile names the package at all', () => {
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("every importer resolves to the root package.json's version", () => {
    const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(resolved).toEqual([root.dependencies[PKG]]);
  });
});
