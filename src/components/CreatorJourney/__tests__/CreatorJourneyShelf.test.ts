// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Journey = React.ComponentProps<typeof CreatorJourneyView>['journey'];
type Earned = Journey['earned'][number];

const badge = (overrides: Partial<Earned>): Earned => ({
  key: 'score:spark',
  track: 'score',
  threshold: 500,
  name: 'Spark',
  description: null,
  badgeUrl: null,
  achievedAt: new Date('2026-10-06T00:00:00Z'),
  ...overrides,
});

const journey = (earned: Earned[]) =>
  ({
    scores: null,
    unlocks: buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs),
    tiers: [],
    earned,
  } as unknown as Journey);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function shelfText(earned: Earned[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorJourneyView, { journey: journey(earned) })
      )
    )
  );
  const heading = [...container.querySelectorAll('h2')].find(
    (h) => h.textContent === 'Badges Earned'
  );
  return heading?.parentElement?.textContent ?? '';
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

// Activity milestones belong to the Achievements section, not this shelf. Granting them nightly
// would otherwise fill the shelf with artless cards the day the job ships.
describe('Badges Earned shelf', () => {
  const firstModel = badge({
    key: 'create:models-1',
    track: 'create',
    threshold: 1,
    name: 'First Model',
  });

  it('holds score tiers and leaves activity milestones out', () => {
    const text = shelfText([badge({}), firstModel]);
    expect(text).toContain('Spark');
    expect(text).not.toContain('First Model');
  });

  it('reads as empty when only activity milestones are held', () => {
    expect(shelfText([firstModel])).toContain('No badges yet.');
  });
});
