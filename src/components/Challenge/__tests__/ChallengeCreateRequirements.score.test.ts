// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import type * as NextRouter from 'next/router';
import type * as GateMessage from '~/components/CreatorJourney/CreatorScoreGateMessage';
import { ChallengeCreateRequirements } from '~/components/Challenge/ChallengeCreateRequirements';
import { CHALLENGE_MIN_CREATOR_SCORE } from '~/shared/constants/challenge.constants';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';

vi.mock('next/router', async (importOriginal) => ({
  ...(await importOriginal<typeof NextRouter>()),
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
}));
vi.mock('~/components/CreatorJourney/CreatorScoreGateMessage', async (importOriginal) => {
  const original = await importOriginal<typeof GateMessage>();
  const { createElement } = await import('react');
  const registry = await import('~/server/services/creator-score-unlocks.service');
  const ladder = {
    unlocks: registry.buildCreatorScoreUnlocks(registry.compiledCreatorScoreUnlockInputs),
    tiers: [],
  };
  return {
    ...original,
    CreatorScoreGateMessage: (props: { score: number | null | undefined; required: number }) =>
      createElement(original.CreatorScoreGateMessageView, { ...props, ladder, journey: true }),
  };
});

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderScoreRow(current: number) {
  const met = current >= CHALLENGE_MIN_CREATOR_SCORE;
  const eligibility = {
    canCreate: met,
    requirements: [{ key: 'score', met, current, min: CHALLENGE_MIN_CREATOR_SCORE }],
  } as unknown as React.ComponentProps<typeof ChallengeCreateRequirements>['eligibility'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(ChallengeCreateRequirements, { eligibility })
      )
    );
  });
  return document.body.textContent ?? '';
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('ChallengeCreateRequirements score row', () => {
  it('tells someone below the gate how far they have to go', () => {
    const text = renderScoreRow(CHALLENGE_MIN_CREATOR_SCORE - 100);
    expect(text).toContain("You're at 4,900, 100 to go.");
    expect(text).not.toContain('Your Creator Score is');
  });

  it('states the score of someone who meets it, without a gap', () => {
    const text = renderScoreRow(CHALLENGE_MIN_CREATOR_SCORE + 250);
    expect(text).toContain('Your Creator Score is 5,250.');
    expect(text).not.toContain('to go');
    const hrefs = [...document.body.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(CREATOR_JOURNEY_HREF);
  });
});
