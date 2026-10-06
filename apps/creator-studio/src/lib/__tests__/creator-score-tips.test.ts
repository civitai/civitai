import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CREATOR_SCORE_TIPS } from '../creator-program';

// The main app's source of truth for score-activity wording. This app cannot import it, so read it.
const MAIN_APP_COPY = fileURLToPath(
  new URL('../../../../../src/components/Account/creator-score-copy.ts', import.meta.url)
);

function mainAppActivities() {
  const source = readFileSync(MAIN_APP_COPY, 'utf8');
  const block = source.slice(source.indexOf('creatorScoreActivities = {'));
  const phrase = (key: string) => block.match(new RegExp(`${key}: '([^']+)'`))?.[1];
  return { models: phrase('models'), images: phrase('images'), articles: phrase('articles') };
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

describe('CREATOR_SCORE_TIPS', () => {
  const activities = mainAppActivities();
  const body = (title: string) => CREATOR_SCORE_TIPS.find((tip) => tip.title === title)?.body;

  it('reads the main app activity wording', () => {
    expect(activities).toEqual({
      models: expect.any(String),
      images: expect.any(String),
      articles: expect.any(String),
    });
  });

  it.each([
    ['Publish models people use', 'models'],
    ['Share images & posts', 'images'],
    ['Write articles', 'articles'],
  ] as const)('words "%s" with the main app explainer activities', (title, key) => {
    expect(body(title)).toMatch(new RegExp(`^${sentence(activities[key] ?? '')} `));
  });
});
