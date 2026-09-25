import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// The moderator app does not import src/, so a hand copy there is a drift surface nothing
// else would notice: a flat-R floor reads exactly like a correct one until a verdict above R.
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

function body(file: string, start: string) {
  const src = read(file);
  expect(src.length, `${file} is empty or unreadable`).toBeGreaterThan(500);
  const from = src.indexOf(start);
  expect(from, `${start} not found in ${file}`).toBeGreaterThan(-1);
  const to = src.indexOf('\n}\n', from);
  return src.slice(from, to === -1 ? undefined : to);
}

const FLAT_FLOOR = `'nsfw' = ANY(em."triggeredLabels")`;
const SHARED_IMPORT =
  /import \{[^}]*\barticleModerationFloorText\b[^}]*\} from '@civitai\/shared\/rated-entity-sql'/;

describe('the moderator app renders the shared Article floor', () => {
  it.each([
    ['apps/moderator/src/lib/server/article-moderation.ts', 'async function restoreArticle('],
    [
      'apps/moderator/src/lib/server/article-rating-reviews.service.ts',
      'export async function computeArticleDerivedNsfwLevel(',
    ],
  ])('%s', (file, start) => {
    expect(read(file)).toMatch(SHARED_IMPORT);
    const fn = body(file, start);
    expect(fn).toContain("articleModerationFloorText('a.id')");
    expect(fn).not.toContain(FLAT_FLOOR);
  });

  it('as does the main app, which the spoke must match', () => {
    for (const file of [
      'src/server/services/nsfwLevels.service.ts',
      'src/server/services/article-rating-review.helpers.ts',
    ]) {
      const src = read(file);
      expect(src).toContain("articleModerationFloorSql('a.id')");
      expect(src).not.toContain(FLAT_FLOOR);
    }
  });

  it('derives Post/Bounty/BountyEntry basis levels from the shared content text', () => {
    const fn = body(
      'apps/moderator/src/lib/server/rated-entity-derivation.ts',
      'export async function computeRatedEntityDerivedNsfwLevel('
    );
    expect(fn).toContain("ratedEntityContentNsfwLevelText(entityType, 'e')");
    expect(fn).toContain('challengeDerivedNsfwLevel(');
    expect(fn).not.toContain('nsfw = TRUE');
  });
});
