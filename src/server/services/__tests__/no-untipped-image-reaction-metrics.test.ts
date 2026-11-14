import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `<Reactions entityType="image">` reads a missing `metrics.tippedAmountCount` as a 0 Buzz tip, so
 * every image reaction bar takes its counts from `imageStatsToReactionMetrics`, inline or as the
 * `initial` of the `<Metrics>` whose render prop it reads.
 *
 * It reads source text: it proves the helper is named at each site, not that it is given the
 * right image's stats.
 */
const componentsDir = path.resolve(__dirname, '../../../components');
const HELPER = 'imageStatsToReactionMetrics(';

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [full] : [];
  });

// The element's own text: `<Tag` up to the first `/>`, or the first `>` that is the first
// non-space character on its line (Prettier's closing bracket). Props here hold no JSX, so either
// one ends the opening tag.
const openingTags = (source: string, tag: string) => {
  const found: string[] = [];
  const re = new RegExp(`<${tag}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const rest = source.slice(m.index);
    const end = rest.search(/\/>|\n\s*>/);
    found.push(end === -1 ? rest : rest.slice(0, end));
  }
  return found;
};

const sites = walk(componentsDir).flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const rel = path.relative(componentsDir, file);
  const imageMetrics = openingTags(source, 'Metrics').filter((t) => /entityType="Image"/.test(t));
  return openingTags(source, 'Reactions')
    .filter((t) => /entityType="image"/.test(t))
    .map((tag) => ({ rel, tag, imageMetrics }));
});

describe('image reaction bars carry the Buzz tip total', () => {
  it('finds the image reaction bars', () => {
    // Named rather than counted, so a scan pointed at the wrong place cannot pass on an empty list.
    expect(sites.map((s) => s.rel)).toEqual(
      expect.arrayContaining([
        'Post/Detail/PostImages.tsx',
        'Model/ModelCarousel/ModelCarousel.tsx',
        'ResourceReview/ResourceReviewCarousel.tsx',
        'Image/Detail/ImageDetailByProps.tsx',
        'Image/DetailV2/ImageDetail2.tsx',
        'Image/Infinite/ImagesCard.tsx',
        'Image/AsPosts/ImagesAsPostsCard.tsx',
      ])
    );
  });

  it('builds every image reaction bar from imageStatsToReactionMetrics', () => {
    const offenders = sites
      .filter(({ tag, imageMetrics }) => {
        if (tag.includes(`metrics={${HELPER}`)) return false;
        // `metrics={metrics}` is a `<Metrics>` render prop; its `initial` must be the helper's.
        if (/metrics=\{metrics\}/.test(tag))
          return !(imageMetrics.length > 0 && imageMetrics.every((t) => t.includes(HELPER)));
        return true;
      })
      .map((s) => s.rel);
    expect(offenders, 'these image reaction bars build their counts by hand').toEqual([]);
  });
});
