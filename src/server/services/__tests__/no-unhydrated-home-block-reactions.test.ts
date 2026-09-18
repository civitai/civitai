import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A home block's rendered payload lives in ONE Redis entry with no user segment and is served
 * through `edgeCacheIt` (`canCache` stays true for a signed-in viewer), so every viewer is handed
 * the same image objects with `reactions: []`. That is not cosmetic: `reaction.toggle` acts on the
 * database row rather than on what is drawn, so a viewer who sees their own reaction
 * un-highlighted clicks it and DELETES it — on 868m6kdp6 the reporter's own two reactions on
 * image 142799705 were verified present and were gone from Postgres two days later.
 *
 * So a home block that renders image cards hydrates them with the viewer's own reactions. This is
 * a guard rather than a comment because the hook call is an ordinary-looking line in a render
 * body: deleting it breaks no type, fails no other test, and the surface it re-breaks is the
 * front page.
 *
 * If you are moving the hydration somewhere better — into `ImagesProvider` itself, say — change
 * what this reads rather than deleting it, and say so here.
 */
const blockDir = path.resolve(__dirname, '../../../components/HomeBlocks');

const blocks = readdirSync(blockDir)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => ({ file: f, source: readFileSync(path.join(blockDir, f), 'utf8') }));

// `<ImageCard` and not `<ImagesProvider`: `ImageCard` is the only card component in the repo that
// renders `<Reactions>`, and a block can mount the provider with `images={undefined}` purely for
// the sticker and remix batches under it — FeaturedModelVersionHomeBlock does exactly that.
const imageBlocks = blocks.filter((b) => b.source.includes('<ImageCard'));

describe('home blocks hydrate the viewer reactions their shared payload cannot carry', () => {
  it('finds the blocks that render image cards', () => {
    // Named rather than counted: a rename or a move that pointed this scan at a directory with no
    // home blocks in it would otherwise leave `it.each` iterating an empty list, reporting green.
    expect(
      imageBlocks.map((b) => b.file).sort(),
      `no home block under ${blockDir} renders an ImageCard; this guard is reading the wrong place`
    ).toEqual(
      expect.arrayContaining([
        'CollectionHomeBlock.tsx',
        'FeaturedCollectionsHomeBlock.tsx',
        'FeedHomeBlock.tsx',
      ])
    );
  });

  it.each(imageBlocks)('$file calls useHydratedImageReactions', ({ source }) => {
    expect(source).toContain('useHydratedImageReactions');
  });
});
