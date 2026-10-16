// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';
import { discordRoleRewards } from '~/components/CreatorJourney/discord-claim-guide';
import { useDialogStore } from '~/components/Dialog/dialogStore';

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
  mythic = false,
}: {
  total: number;
  earnedKeys: string[];
  unlocks?: unknown[];
  mythic?: boolean;
}) =>
  ({
    scores: { total },
    unlocks,
    tiers: [
      tier('score:star', 'Star', 100_000),
      tier('score:supernova', 'Supernova', 1_000_000),
      tier('score:legend', 'Legend', 10_000_000),
      ...(mythic ? [tier('score:mythic', 'Mythic', 100_000_000)] : []),
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
    share: { shareable: [], hiddenOnProfile: [] },
  } as unknown as Journey);

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const HOW_TO_CLAIM = ' How to claim';

/** Each list item's text, and whether it shows the check rather than the lock. */
function items(props: {
  total: number;
  earnedKeys: string[];
  unlocks?: unknown[];
  mythic?: boolean;
}) {
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
      const text = li.textContent ?? '';
      const key = text.endsWith(HOW_TO_CLAIM) ? text.slice(0, -HOW_TO_CLAIM.length) : text;
      return [key, { checked, locked }];
    })
  );
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  useDialogStore.getState().closeAll();
});

const SUPERNOVA = tierRewards['score:supernova'] ?? [];
const LEGEND = tierRewards['score:legend'] ?? [];
const MYTHIC = tierRewards['score:mythic'] ?? [];

describe('tier rewards on the ladder', () => {
  it('lists every Supernova and Legend reward, leaving "Recognition only" to tiers without any', () => {
    const rendered = items({ total: 0, earnedKeys: [] });
    expect([...SUPERNOVA, ...LEGEND].filter((reward) => !rendered.has(reward))).toEqual([]);
    expect(SUPERNOVA).toHaveLength(4);
    expect(LEGEND).toHaveLength(5);
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
    expect([...rendered.keys()].filter((text) => SUPERNOVA.includes(text))).toHaveLength(4);
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

  it('puts How to claim on each Discord role row only, opening that tier’s guide', () => {
    items({ total: 0, earnedKeys: [] });
    const buttons = [...(container?.querySelectorAll('li button') ?? [])];
    expect(buttons.map((b) => b.closest('li')?.textContent)).toEqual([
      discordRoleRewards['score:supernova'].line + HOW_TO_CLAIM,
      discordRoleRewards['score:legend'].line + HOW_TO_CLAIM,
    ]);

    act(() => (buttons[1] as HTMLButtonElement).click());
    expect(useDialogStore.getState().dialogs.map((d) => d.props)).toEqual([{ tier: 'legend' }]);
  });

  it('keeps How to claim on an earned rung', () => {
    items({ total: 20_000_000, earnedKeys: ['score:supernova', 'score:legend'] });
    expect(container?.querySelectorAll('li button')).toHaveLength(2);
  });

  it('lists the Mythic rewards on its rung, checked once granted, with its own role guide', () => {
    const locked = items({ total: 0, earnedKeys: [], mythic: true });
    expect(MYTHIC).toHaveLength(4);
    for (const reward of MYTHIC)
      expect(locked.get(reward)).toEqual({ checked: false, locked: true });
    act(() => root?.unmount());
    container?.remove();

    const earned = items({
      total: 120_000_000,
      earnedKeys: ['score:supernova', 'score:legend', 'score:mythic'],
      mythic: true,
    });
    for (const reward of MYTHIC)
      expect(earned.get(reward)).toEqual({ checked: true, locked: false });
    const buttons = [...(container?.querySelectorAll('li button') ?? [])];
    expect(buttons.map((b) => b.closest('li')?.textContent)).toContain(
      discordRoleRewards['score:mythic'].line + HOW_TO_CLAIM
    );
    act(() => (buttons[buttons.length - 1] as HTMLButtonElement).click());
    expect(useDialogStore.getState().dialogs.map((d) => d.props)).toEqual([{ tier: 'mythic' }]);
  });
});
