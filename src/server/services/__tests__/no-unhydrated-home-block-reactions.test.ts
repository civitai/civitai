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
 * 🔴 WHAT THIS CANNOT SEE. It reads source text, so it proves a block MENTIONS the hook, not that
 * the hydrated array reaches the cards. That gap is real and was found by review: keeping the
 * call and rendering a second, un-hydrated binding restores the bug in full with this green. The
 * second assertion is the answer — it requires the hook's result to be passed straight into
 * `useDedupedCappedItems`, so the rendered list is the hook's own output and no second binding
 * exists to render instead. Structure, not discipline.
 *
 * If you are moving the hydration somewhere better — into `ImagesProvider` itself, say — change
 * what this reads rather than deleting it, and say so here.
 */
const blockDir = path.resolve(__dirname, '../../../components/HomeBlocks');

const blocks = readdirSync(blockDir)
  .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
  .map((f) => ({ file: f, source: readFileSync(path.join(blockDir, f), 'utf8') }));

// `<ImageCard` and not `<ImagesProvider`: a block can mount the provider with `images={undefined}`
// purely for the sticker and remix batches under it, as FeaturedModelVersionHomeBlock does.
// `ImageCard` is the only card a home block renders that shows reaction state — `ModelCard`,
// `PostCard` and `ArticleCard` render no reactions at all. (Three OTHER components in the repo do
// render `<Reactions>`: ImagesCard, ImagesAsPostsCard and BountyEntryCard. None is reachable from
// a home block, and all three sit on per-viewer surfaces that carry reactions already.)
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

  // There was a `toContain('useHydratedImageReactions')` assertion here. It is gone because it
  // could barely fail: deleting the CALL leaves the import, and the string with it — measured,
  // the mutation that removed the call reddened only the assertion below. That one subsumes it.
  it.each(imageBlocks)('$file renders the hook output, not a second binding', ({ source }) => {
    expect(
      source,
      'pass useHydratedImageReactions(...) straight into useDedupedCappedItems, so the list that renders IS the hydrated one'
    ).toMatch(/useDedupedCappedItems\(\s*useHydratedImageReactions\(/);
  });

  it('keeps the lookup behind an authenticated procedure', () => {
    // A public procedure resolving `ctx.user?.id ?? 0` would answer "you have reacted to none of
    // these" for a signed-out viewer — the exact state that gets a reaction clicked off — instead
    // of failing where someone would notice.
    const router = readFileSync(
      path.resolve(__dirname, '../../routers/reaction.router.ts'),
      'utf8'
    );
    expect(router).toContain('getMyImageReactions: protectedProcedure');
  });
});
