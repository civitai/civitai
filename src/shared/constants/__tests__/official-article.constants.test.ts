import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  OFFICIAL_ARTICLE_TAG,
  hasOfficialArticleTag,
  isOfficialArticleTag,
} from '~/shared/constants/official-article.constants';

const repoRoot = path.resolve(__dirname, '../../../..');
const read = (relative: string) =>
  fs.readFileSync(path.join(repoRoot, ...relative.split('/')), 'utf-8');

describe('isOfficialArticleTag', () => {
  it('matches the tag the migration creates', () => {
    expect(isOfficialArticleTag({ name: 'civitai official' })).toBe(true);
  });

  // `Tag.name` is `citext` and `article.service` lowercases on the attach path, but a
  // payload is only as clean as the query that built it.
  it.each(['Civitai Official', 'CIVITAI OFFICIAL', '  civitai official  '])(
    'matches %j',
    (name) => {
      expect(isOfficialArticleTag({ name })).toBe(true);
    }
  );

  // 🔴 The negative that matters, and it is not hypothetical. A tag named `official`
  // already exists on prod (id 123833, targets Post, NOT adminOnly) and is on 8 posts,
  // applied by ordinary users. A looser match — `includes('official')`, or matching the
  // bare word — would paint a Civitai provenance badge on whatever those users tagged.
  it.each(['official', 'unofficial', 'civitai', 'civitai officials', 'official civitai'])(
    'does not match %j',
    (name) => {
      expect(isOfficialArticleTag({ name })).toBe(false);
    }
  );

  it.each([{ name: null }, { name: undefined }, {}])('does not match %j', (tag) => {
    expect(isOfficialArticleTag(tag)).toBe(false);
  });

  it('finds the tag among an article’s other tags, and reports absence', () => {
    const others = [{ name: 'announcement' }, { name: 'news' }];
    expect(hasOfficialArticleTag(others)).toBe(false);
    expect(hasOfficialArticleTag([...others, { name: OFFICIAL_ARTICLE_TAG }])).toBe(true);
    expect(hasOfficialArticleTag([])).toBe(false);
    expect(hasOfficialArticleTag(undefined)).toBe(false);
  });
});

/**
 * The name is one string in two systems: this constant, and the `Tag` row the migration
 * creates. Nothing at runtime reconciles them — a rename in either place leaves a badge
 * that silently never renders, with no error anywhere and a passing suite.
 */
describe('the constant and the migration agree on the name', () => {
  const migration = read(
    'packages/civitai-db-schema/prisma/migrations/20260904160000_civitai_official_article_tag/migration.sql'
  );

  it('the migration inserts exactly the tag this constant names', () => {
    expect(migration).toContain(`VALUES ('${OFFICIAL_ARTICLE_TAG}'`);
  });

  // The permission model, pinned in the only place it is written down. Without
  // `adminOnly` the badge is forgeable: article tags attach by NAME through
  // `connectOrCreate`, so anyone who can type the name can claim it.
  it('the migration creates it adminOnly, and repairs it if cleared', () => {
    expect(migration).toMatch(/"adminOnly"\s*=\s*true/);
    expect(migration).toMatch(/ON CONFLICT \("name"\) DO UPDATE/);
  });
});

/**
 * Rendering the badge component directly would leave every test above green with the
 * badge on no page at all — the failure mode #4141 shipped and 868kuq3jk had to clean up.
 * These are the only assertions that anything in the app draws it.
 */
describe('the article surfaces render the badge', () => {
  it.each([['src/components/Cards/ArticleCard.tsx'], ['src/pages/articles/[id]/[[...slug]].tsx']])(
    '%s renders <OfficialArticleBadge />',
    (relative) => {
      const source = read(relative);
      // Comments stripped first: commenting the mount out is likelier than deleting it and
      // leaves the string in place. The character class after the name is deliberate — a
      // bare `includes('<OfficialArticleBadge')` is a PREFIX match, satisfied by
      // `<OfficialArticleBadgeSkeleton />` with the real badge mounted nowhere.
      const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const mounted = code
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /<OfficialArticleBadge[\s/>]/.test(line) && !line.startsWith('//'));

      expect(mounted).toHaveLength(1);
    }
  );

  // The detail page draws every non-category tag as a grey chip. Without this filter the
  // official tag appears twice on one line — once as provenance, once as a topic.
  it('the detail page keeps the official tag out of the ordinary tag row', () => {
    // Whitespace collapsed first: this line is close enough to printWidth that one more
    // condition makes Prettier wrap it, and a guard that reddens on a re-wrap is a guard
    // people delete.
    const source = read('src/pages/articles/[id]/[[...slug]].tsx').replace(/\s+/g, ' ');
    expect(source).toMatch(/const tags = article\.tags\.filter\(.*isOfficialArticleTag/);
  });
});
