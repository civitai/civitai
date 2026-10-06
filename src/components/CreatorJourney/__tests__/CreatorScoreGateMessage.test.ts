// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { creatorScoreGrowsWhen } from '~/components/Account/creator-score-copy';
import { CreatorScoreGateMessageView } from '~/components/CreatorJourney/CreatorScoreGateMessage';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import {
  CREATOR_JOURNEY_HREF,
  CREATOR_SCORE_EXPLAINER_HREF,
} from '~/shared/constants/creator-journey.constants';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ladder = {
  unlocks: buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs),
  tiers: [
    { key: 'score:spark', name: 'Spark', threshold: CRUCIBLE_JUDGE_MIN_CREATOR_SCORE, hint: null },
  ],
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type ViewProps = React.ComponentProps<typeof CreatorScoreGateMessageView>;

function render({ journey = true, ...rest }: Omit<ViewProps, 'journey'> & { journey?: boolean }) {
  const props: ViewProps = { ...rest, journey };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement('p', null, React.createElement(CreatorScoreGateMessageView, props))
      )
    );
  });
  const el = container.querySelector('p') as HTMLParagraphElement;
  return {
    text: el.textContent ?? '',
    hrefs: [...el.querySelectorAll('a')].map((a) => a.getAttribute('href')),
  };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

const required = CHALLENGE_MIN_CREATOR_SCORE;

describe('CreatorScoreGateMessageView with Creator Journey flagged off', () => {
  it('names no tier and links no journey below the gate, even with the ladder loaded', () => {
    const { text, hrefs } = render({ score: 1, required, ladder, journey: false });
    expect(text).not.toContain('Spark');
    expect(text).toContain(`to go`);
    expect(hrefs).toEqual([CREATOR_SCORE_EXPLAINER_HREF]);
  });

  it('points someone who meets the gate at the explainer, not the journey', () => {
    const { hrefs } = render({ score: required, required, ladder, journey: false });
    expect(hrefs).toEqual([CREATOR_SCORE_EXPLAINER_HREF]);
  });

  it('points someone whose score is unknown at the explainer, not the journey', () => {
    const { hrefs } = render({ score: undefined, required, ladder, journey: false });
    expect(hrefs).toEqual([CREATOR_SCORE_EXPLAINER_HREF]);
  });
});

describe('CreatorScoreGateMessageView', () => {
  it('points someone far below the gate at the nearest rung and the journey', () => {
    const { text, hrefs } = render({ score: 120, required, ladder });

    expect(text).toBe(
      "You're at 120. Your next step is Spark at 500, which unlocks: judge crucibles. See your journey"
    );
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF]);
  });

  it('states the gap close to the gate and links to what moves the score', () => {
    const { text, hrefs } = render({ score: required - 300, required, ladder });

    expect(text).toBe(
      "You're at 4,700, 300 to go. Scores update once a day. See what moves your score"
    );
    expect(hrefs).toEqual([CREATOR_SCORE_EXPLAINER_HREF]);
  });

  it('explains where a score comes from when there is none', () => {
    const { text, hrefs } = render({ score: 0, required, ladder });

    expect(text).toMatch(/^You don't have a Creator Score yet\./);
    expect(text).toContain(`It starts when ${creatorScoreGrowsWhen}, and it updates once a day.`);
    expect(hrefs).toEqual([CREATOR_SCORE_EXPLAINER_HREF]);
  });

  it('never claims there is no score when it only does not know it', () => {
    const { text, hrefs } = render({ score: undefined, required, ladder });

    expect(text).not.toMatch(/don't have a Creator Score/);
    expect(text).not.toMatch(/You're at/);
    expect(text).toContain(`grows when ${creatorScoreGrowsWhen}, and it updates once a day.`);
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF]);
  });

  it('states the score of someone who meets the gate, and links to the journey', () => {
    const { text, hrefs } = render({ score: required + 250, required, ladder });

    expect(text).toBe('Your Creator Score is 5,250. See your journey');
    expect(hrefs).toEqual([CREATOR_JOURNEY_HREF]);
  });

  it('shows only the score while the ladder loads', () => {
    expect(render({ score: 120, required, ladder: undefined }).text).toBe(
      "You're at 120. See your journey"
    );
  });
});
