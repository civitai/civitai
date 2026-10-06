import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { MIN_CREATOR_SCORE } from '$lib/creator-program';

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }));

const { default: Page } = await import('./+page.svelte');

const JOURNEY_URL = 'https://main-app.test/creators/journey';
const LINK_TEXT = 'See your full Creator Journey on Civitai';

function bodyFor(creatorScore: number, creatorJourneyUrl: string | null) {
  const data = {
    creatorScore,
    estimate: null,
    creatorJourneyUrl,
    membership: { isMember: false, isCreatorProgramMember: false },
  };
  return render(Page, { props: { data } as never }).body;
}

// Justin's call: every /join visitor sees the link, not only those still growing their score.
describe('/join creator journey link placement', () => {
  it('shows a qualifying-score visitor the link when the flag is on', () => {
    const body = bodyFor(MIN_CREATOR_SCORE, JOURNEY_URL);
    expect(body).not.toContain('How to grow your creator score');
    expect(body).toContain(`href="${JOURNEY_URL}"`);
    expect(body).toContain(LINK_TEXT);
  });

  it('shows a visitor still below the bar the link when the flag is on', () => {
    const body = bodyFor(0, JOURNEY_URL);
    expect(body).toContain('How to grow your creator score');
    expect(body).toContain(`href="${JOURNEY_URL}"`);
  });

  it('hides the link from a qualifying-score visitor when the flag is off', () => {
    const body = bodyFor(MIN_CREATOR_SCORE, null);
    expect(body).toContain('Your creator score');
    expect(body).not.toContain(LINK_TEXT);
  });
});
