import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { MARKETPLACE_CATEGORIES } from '../marketplace-categories.constants';

/**
 * Drift guard (W13 category-on-approve): the canonical published manifest schema
 * at `public/schemas/app-block/v1.json` declares an OPTIONAL top-level `category`
 * whose `enum` MUST equal `MARKETPLACE_CATEGORIES` exactly. The schema is the
 * source of truth the `civitai` CLI's vendored copy + editor validation compare
 * against; the const is what the server-side validator + approve path reference.
 * If someone adds/removes a category in ONE place only, this fails loudly so the
 * canonical schema and the runtime const can never silently diverge.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');

describe('app-block v1 schema ⇄ MARKETPLACE_CATEGORIES drift guard', () => {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as {
    properties?: { category?: { type?: unknown; enum?: unknown } };
  };

  it('declares category as an optional string enum', () => {
    const category = schema.properties?.category;
    expect(category).toBeDefined();
    expect(category?.type).toBe('string');
    expect(Array.isArray(category?.enum)).toBe(true);
    // Optional: must NOT be listed in the schema's top-level `required`.
    const required = (schema as { required?: unknown }).required;
    expect(Array.isArray(required) ? (required as string[]) : []).not.toContain('category');
  });

  it('category enum equals MARKETPLACE_CATEGORIES exactly (order included)', () => {
    const schemaEnum = schema.properties?.category?.enum as string[];
    expect(schemaEnum).toEqual([...MARKETPLACE_CATEGORIES]);
  });
});
