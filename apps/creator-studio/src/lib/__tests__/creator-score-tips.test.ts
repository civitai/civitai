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
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  // The full phrase must be followed by "of"/"on", so a main-app phrase that loses a trailing
  // activity no longer matches a tip that still lists it.
  it.each([
    ['Publish models people use', 'models'],
    ['Share images & posts', 'images'],
    ['Write articles', 'articles'],
  ] as const)('words "%s" with the main app explainer activities', (title, key) => {
    const phrase = escapeRegExp(sentence(activities[key] ?? ''));
    expect(body(title)).toMatch(new RegExp(`^${phrase} (of|on) `));
  });

  it('ranks no score source above another', () => {
    for (const tip of CREATOR_SCORE_TIPS)
      expect(tip.body).not.toMatch(/largest|biggest|most important/i);
  });
});
