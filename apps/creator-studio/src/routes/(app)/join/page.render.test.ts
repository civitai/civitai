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

// From the score panel's label to the tips card, or the end of the page when the card is absent.
function scorePanel(body: string) {
  const end = body.indexOf('How to grow your creator score');
  return body.slice(body.indexOf('Your creator score'), end === -1 ? undefined : end);
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
    expect(body).toContain('action="?/join"');
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
