import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFeedGoInputSchemas,
  FEED_GO_INPUT_SCHEMAS_PATH,
  renderFeedGoInputSchemas,
} from '../feed-go-input-schemas';

// The Go feed service accepts only the input keys this committed file lists, and reads its defaults
// from it. A key added to (or removed from) getInfiniteImagesSchema, getAllModelsSchema or the
// /api/v1/images schema must regenerate it, or the Go parsers judge requests by a stale schema.
describe('apps/feed-go inputschema/schemas.json', () => {
  it('is what the zod schemas project to today (regenerate: pnpm exec tsx scripts/feed-go-input-schemas.ts)', () => {
    expect(readFileSync(FEED_GO_INPUT_SCHEMAS_PATH, 'utf8')).toBe(renderFeedGoInputSchemas());
  });

  // Positive control: the projection reads the real schemas, so known keys and defaults are in it,
  // pinned as literals.
  it('holds the keys and defaults the Go parsers read', () => {
    const schemas = buildFeedGoInputSchemas();
    expect(schemas.getInfiniteImagesSchema.keys).toEqual(
      expect.arrayContaining(['limit', 'cursor', 'include', 'withMeta', 'hubId'])
    );
    expect(schemas.getInfiniteImagesSchema.defaults).toMatchObject({
      limit: 100,
      sort: 'Most Reactions',
      period: 'AllTime',
      periodMode: 'published',
    });
    expect(schemas.getAllModelsSchema.keys).toEqual(
      expect.arrayContaining(['page', 'tagname', 'allowCommercialUse'])
    );
    expect(schemas.getAllModelsSchema.defaults).toMatchObject({ sort: 'Highest Rated' });
    expect(schemas.imagesEndpointSchema.keys).toEqual(
      expect.arrayContaining(['ids', 'flatMeta', 'nsfw'])
    );
    // Not a schema key: the tRPC client adds these and zod strips them.
    expect(schemas.getInfiniteImagesSchema.keys).not.toContain('authed');
  });
});
