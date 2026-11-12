import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `app_listings.issue_tracker_url` is NOT a Prisma model field.
 *
 * The column is manual-apply. As an ordinary field, every `appListing` call that passes no
 * `select` would name it in its generated SELECT / RETURNING list and fail with P2022 until the
 * migration is applied — the off-site submit 500 that `source_repo_url` and `visibility` both
 * caused on a preview environment. The field therefore carries `// @no-type` in the full schema,
 * the slim schema the client is generated from does not declare it, and the generated Kysely
 * types do not carry it. Same three facts `app-listing-visibility.no-prisma-field` pins.
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function appListingModel(schema: string): string {
  const at = schema.indexOf('model AppListing {');
  expect(at).toBeGreaterThan(0);
  return schema.slice(at, schema.indexOf('\n}', at));
}

/** Field declarations only — comment lines dropped, so prose cannot answer for a field. */
function fieldLines(model: string): string[] {
  return model
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('@@') && l !== '{');
}

const declares = (model: string, name: string) =>
  fieldLines(model).some((l) => new RegExp(`^${name}\\s+\\S`).test(l));

describe('app_listings.issue_tracker_url is NOT a Prisma model field', () => {
  const full = appListingModel(read('packages/civitai-db-schema/prisma/schema.full.prisma'));
  const slim = appListingModel(read('packages/civitai-db-schema/prisma/schema.prisma'));

  it('POSITIVE CONTROL: the scan sees real fields on both schemas', () => {
    expect(declares(full, 'sourceRepoUrl')).toBe(true);
    expect(declares(slim, 'sourceRepoUrl')).toBe(true);
    expect(declares(full, 'thisIsNotAField')).toBe(false);
  });

  it('the FULL schema declares it, mapped to the column, with an inline // @no-type', () => {
    const line = fieldLines(full).find((l) => /^issueTrackerUrl\s+\S/.test(l));
    expect(line).toBeDefined();
    expect(line).toContain('@map("issue_tracker_url")');
    expect(line).toContain('// @no-type');
  });

  it('🔴 the SLIM schema (what the client is generated from) has no such field', () => {
    expect(declares(slim, 'issueTrackerUrl')).toBe(false);
  });

  it('🔴 the generated Kysely AppListing type has no issue_tracker_url', () => {
    const types = read('packages/civitai-db-schema/src/kysely/types.ts');
    const at = types.indexOf('export type AppListing = {');
    expect(at).toBeGreaterThan(0);
    const block = types.slice(at, types.indexOf('\n};', at));
    expect(block).toContain('source_repo_url');
    expect(block).not.toContain('issue_tracker_url');
  });
});
