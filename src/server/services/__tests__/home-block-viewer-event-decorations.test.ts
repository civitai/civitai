import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A home block's payload is one cache entry every viewer shares, fetched with no viewer, so before
 * an event's start it carries no event hats even for the flagged viewers who see them on every
 * feed. Each block that renders content cards adds the viewer's own with
 * `useViewerEventDecorations`, composed INLINE into the list it caps and renders, as the reaction
 * hydration is (see no-unhydrated-home-block-reactions.test.ts for why inline).
 *
 * Reads source text: it proves every capped list goes through the hook, not that the hook works
 * (useViewerEventDecorations.test.ts) or that a card draws `eventDecoration` (unchanged here).
 */
const blockDir = path.resolve(__dirname, '../../../components/HomeBlocks');

const blocks = readdirSync(blockDir)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => ({ file: f, source: readFileSync(path.join(blockDir, f), 'utf8') }));

const cardBlocks = blocks.filter((b) => /<(ImageCard|ModelCard|ArticleCard)\b/.test(b.source));

// The overlay's own arguments are captured too: the list must be the one hidden preferences already
// filtered, and the entity the one the block's cards are (a model grid asking about image hats would
// hat the wrong content).
const OVERLAID_CAP =
  /useDedupedCappedItems\(\s*(?:useHydratedImageReactions\(\s*)?useViewerEventDecorations\(\s*filtered,\s*\{\s*entity:\s*('image'|'model'|type)\s*\}\s*\)/g;

const EXPECTED_ENTITIES: Record<string, string[]> = {
  'CollectionHomeBlock.tsx': ['type'],
  'FeaturedCollectionsHomeBlock.tsx': ['type'],
  'FeaturedModelVersionHomeBlock.tsx': ["'model'"],
  'FeedHomeBlock.tsx': ["'image'", "'model'"],
};

describe('home blocks overlay the viewer event hats their shared payload cannot carry', () => {
  it('finds the blocks that render content cards', () => {
    expect(cardBlocks.map((b) => b.file).sort()).toEqual(
      expect.arrayContaining([
        'CollectionHomeBlock.tsx',
        'FeaturedCollectionsHomeBlock.tsx',
        'FeaturedModelVersionHomeBlock.tsx',
        'FeedHomeBlock.tsx',
      ])
    );
  });

  it.each(cardBlocks)('$file overlays every list it caps', ({ file, source }) => {
    const caps = source.match(/useDedupedCappedItems\(/g) ?? [];
    expect(caps.length, 'no capped list found; this guard reads the wrong shape').toBeGreaterThan(
      0
    );
    expect(
      (source.match(OVERLAID_CAP) ?? []).length,
      'compose useViewerEventDecorations into each useDedupedCappedItems call'
    ).toBe(caps.length);
    const entities = [...source.matchAll(OVERLAID_CAP)].map((m) => m[1]);
    expect(entities, 'each grid asks about the entity its cards are').toEqual(
      EXPECTED_ENTITIES[file]
    );
  });
});
