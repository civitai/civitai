import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { MIN_CREATOR_SCORE } from '$lib/creator-program';
import Page from './+page.svelte';
import type { PageData } from './$types';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }));

const JOURNEY_URL = 'https://main-app.test/creators/journey';
const LINK_TEXT = 'See your full Creator Journey on Civitai';

type Fixture = Pick<PageData, 'creatorScore' | 'estimate' | 'creatorJourneyUrl'> & {
  membership: Pick<PageData['membership'], 'isMember'>;
};

function bodyFor(creatorScore: number, creatorJourneyUrl: string | null, isMember = false) {
  const data = {
    creatorScore,
    estimate: null,
    creatorJourneyUrl,
    membership: { isMember },
  } satisfies Fixture;
  // The page reads only these fields; the layout's are left out on purpose.
  return render(Page, { props: { data: data as unknown as PageData } }).body;
}

const links = (body: string) => body.split(`href="${JOURNEY_URL}"`).length - 1;

function scorePanel(body: string) {
  const start = body.lastIndexOf('<div', body.indexOf('cs-panel'));
  expect(body.slice(start, body.indexOf('Your creator score'))).not.toContain('</div>');
  const tags = /<\/?div[\s>]/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let tag = tags.exec(body); tag; tag = tags.exec(body)) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return body.slice(start, tags.lastIndex);
  }
  throw new Error('score panel not found');
}

describe('/join creator journey link placement', () => {
  it('shows a qualifying-score visitor the link when the flag is on', () => {
    const body = bodyFor(MIN_CREATOR_SCORE, JOURNEY_URL);
    expect(body).not.toContain('How to grow your creator score');
    expect(links(scorePanel(body))).toBe(1);
    expect(links(body)).toBe(1);
    expect(body).toContain(LINK_TEXT);
  });

  it('shows a qualifying member the link beside the join button', () => {
    const body = bodyFor(MIN_CREATOR_SCORE, JOURNEY_URL, true);
    expect(scorePanel(body)).toContain('action="?/join"');
    expect(links(scorePanel(body))).toBe(1);
    expect(links(body)).toBe(1);
  });

  it('shows a visitor still below the bar the link once', () => {
    const body = bodyFor(0, JOURNEY_URL);
    expect(body).toContain('How to grow your creator score');
    expect(links(scorePanel(body))).toBe(1);
    expect(links(body)).toBe(1);
    expect(body).toContain(LINK_TEXT);
  });

  it('hides the link from a qualifying-score visitor when the flag is off', () => {
    const body = bodyFor(MIN_CREATOR_SCORE, null);
    expect(body).toContain('Your creator score');
    expect(body).not.toContain(LINK_TEXT);
  });
});
