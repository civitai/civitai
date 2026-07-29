import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { MANIFEST_TAGLINE_MAX_LENGTH } from '~/server/services/block-manifest-validator.service';
import { OFFSITE_TAGLINE_MAX } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * Drift guard — manifest `tagline`.
 *
 * THREE places declare the tagline bound and they must never diverge:
 *   1. the canonical published schema `public/schemas/app-block/v1.json` (what
 *      the `civitai` CLI byte-mirrors + what editors validate against),
 *   2. `MANIFEST_TAGLINE_MAX_LENGTH` — the IMPERATIVE validator's cap, which is
 *      the authoritative gate at submit/approve (the JSON schema is a shape hint),
 *   3. `OFFSITE_TAGLINE_MAX` — the off-site listing bound. Onsite + offsite
 *      taglines render in the SAME store card/detail slot, so they share a cap.
 *
 * The validator deliberately re-declares the number rather than importing (2)
 * from (3) — it is client-bundle-safe and `offsite-listing.schema` pulls in zod +
 * the external-app schema graph. This test is what makes that duplication safe.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

describe('app-block v1 schema ⇄ tagline bound drift guard', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    required?: unknown;
    properties?: {
      tagline?: {
        type?: unknown;
        minLength?: unknown;
        maxLength?: unknown;
        pattern?: unknown;
      };
    };
  };

  it('declares tagline as an OPTIONAL non-empty string', () => {
    const tagline = schema.properties?.tagline;
    expect(tagline).toBeDefined();
    expect(tagline?.type).toBe('string');
    expect(tagline?.minLength).toBe(1);
    // Optional: must NOT be listed in the schema's top-level `required`.
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    expect(required).not.toContain('tagline');
  });

  it('rejects a whitespace-only tagline the same way the validator does', () => {
    // The validator rejects a BLANK tagline (it trims first). JSON Schema's
    // minLength counts characters, so `"   "` would slip through it — the
    // `\S` pattern is what keeps the schema from being MORE PERMISSIVE than the
    // server, which is the divergence direction that actually hurts (a dev
    // green locally, rejected at submit).
    const pattern = schema.properties?.tagline?.pattern;
    expect(pattern).toBe('\\S');
    const re = new RegExp(pattern as string);
    expect(re.test('   ')).toBe(false);
    expect(re.test('')).toBe(false);
    expect(re.test('\n\t ')).toBe(false);
    expect(re.test('A crisp one-liner')).toBe(true);
    // Padding around real content still passes the schema — matching the server,
    // which trims before measuring. (The validator's own blank/over-cap
    // rejections are covered in block-manifest-validator.service.test.ts; this
    // guard's job is only that the SCHEMA is never the more permissive of the two.)
    expect(re.test('  padded  ')).toBe(true);
  });

  it('schema maxLength equals the validator cap MANIFEST_TAGLINE_MAX_LENGTH', () => {
    expect(schema.properties?.tagline?.maxLength).toBe(MANIFEST_TAGLINE_MAX_LENGTH);
  });

  it('the validator cap equals the off-site listing cap (one bound per store slot)', () => {
    expect(MANIFEST_TAGLINE_MAX_LENGTH).toBe(OFFSITE_TAGLINE_MAX);
  });
});
