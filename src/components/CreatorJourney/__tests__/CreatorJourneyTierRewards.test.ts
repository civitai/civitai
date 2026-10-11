// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Journey = React.ComponentProps<typeof CreatorJourneyView>['journey'];

const tier = (key: string, name: string, threshold: number) => ({
  key,
  name,
  threshold,
  hint: null,
  badgeUrl: null,
});

const SUPERNOVA_BAND_UNLOCK = {
  key: 'test:supernova-band',
  minScore: 500_000,
  label: 'A feature unlock in the Supernova band',
  surface: 'placements',
  scoreKind: 'total',
  source: 'compiled',
};

const journey = ({
  total,
  earnedKeys,
  unlocks = [],
}: {
  total: number;
  earnedKeys: string[];
  unlocks?: unknown[];
}) =>
  ({
    scores: { total },
    unlocks,
    tiers: [
      tier('score:star', 'Star', 100_000),
      tier('score:supernova', 'Supernova', 1_000_000),
      tier('score:legend', 'Legend', 10_000_000),
    ],
    earned: earnedKeys.map((key) => ({
      key,
      track: 'score',
      threshold: null,
      name: key,
      description: null,
      badgeUrl: null,
      achievedAt: new Date('2026-10-06T00:00:00Z'),
    })),
    activity: { milestones: [], closestNext: null },
    secrets: [],
  } as unknown as Journey);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/** Each list item's text, and whether it shows the check rather than the lock. */
function items(props: { total: number; earnedKeys: string[]; unlocks?: unknown[] }) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorJourneyView, { journey: journey(props) })
      )
    )
  );
  return new Map(
    [...container.querySelectorAll('li')].map((li) => {
      const icon = li.querySelector('svg');
      const checked = icon?.classList.contains('tabler-icon-circle-check') ?? false;
      const locked = icon?.classList.contains('tabler-icon-lock') ?? false;
      return [li.textContent ?? '', { checked, locked }];
    })
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

const SUPERNOVA = tierRewards['score:supernova'] ?? [];
const LEGEND = tierRewards['score:legend'] ?? [];

describe('tier rewards on the ladder', () => {
  it('lists every Supernova and Legend reward, leaving "Recognition only" to tiers without any', () => {
    const rendered = items({ total: 0, earnedKeys: [] });
    expect([...SUPERNOVA, ...LEGEND].filter((reward) => !rendered.has(reward))).toEqual([]);
    expect(SUPERNOVA).toHaveLength(3);
    expect(LEGEND).toHaveLength(4);
    expect(rendered.has('An animated Legend name plate on your username')).toBe(true);
    expect(container?.textContent?.split('Recognition only').length).toBe(2);
  });

  it('checks a tier’s rewards once its badge is granted, and locks the next tier’s', () => {
    const rendered = items({ total: 2_000_000, earnedKeys: ['score:supernova'] });
    for (const reward of SUPERNOVA)
      expect(rendered.get(reward)).toEqual({ checked: true, locked: false });
    for (const reward of LEGEND)
      expect(rendered.get(reward)).toEqual({ checked: false, locked: true });
  });

  it('lists a rung’s feature unlocks beside its rewards', () => {
    const rendered = items({
      total: 0,
      earnedKeys: [],
      unlocks: [SUPERNOVA_BAND_UNLOCK],
    });
    expect([...rendered.keys()].filter((text) => SUPERNOVA.includes(text))).toHaveLength(3);
    expect(rendered.get(`${SUPERNOVA_BAND_UNLOCK.label} (from 500,000)`)).toEqual({
      checked: false,
      locked: true,
    });
  });

  // Past the last tier each score is its own rung, so these three rows sit on three rungs.
  it('links Creator Studio once across a run of rungs that would each link it', () => {
    const unlock = (key: string, minScore: number, label: string) => ({
      ...SUPERNOVA_BAND_UNLOCK,
      key,
      minScore,
      label,
    });
    const rendered = items({
      total: 0,
      earnedKeys: [],
      unlocks: [
        unlock('monetize-pricing:20000000', 20_000_000, 'Price higher'),
        unlock('early-access-days:30000000', 30_000_000, 'Longer early access'),
        unlock('early-access-quantity:40000000', 40_000_000, 'More early access'),
      ],
    });
    expect(
      ['Price higher', 'Longer early access', 'More early access'].every((label) =>
        [...rendered.keys()].some((text) => text.startsWith(label))
      )
    ).toBe(true);
    const studioLinks = [...(container?.querySelectorAll('li a') ?? [])].filter((a) =>
      a.getAttribute('href')?.endsWith('/models')
    );
    expect(studioLinks.map((a) => a.textContent)).toEqual(['Price higher']);
  });

  // The badge is granted by a nightly job, so a score past the threshold has not earned the rewards yet.
  it('keeps the rewards locked between crossing the score and the grant', () => {
    const rendered = items({ total: 2_000_000, earnedKeys: [] });
    for (const reward of SUPERNOVA)
      expect(rendered.get(reward)).toEqual({ checked: false, locked: true });
  });
});
