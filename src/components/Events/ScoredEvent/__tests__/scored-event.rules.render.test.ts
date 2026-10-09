// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as EventsUtils from '~/components/Events/events.utils';

/**
 * "How it works": numbered steps in the team colours, the points as figures, the fairness rules as
 * a checklist, the prize and the questions. Nothing in it is clickable but the questions.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COLORS: Record<string, string> = {
  Yellow: '#fcc419',
  Blue: '#339af0',
  Pink: '#f06595',
  Green: '#40c057',
};
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof EventsUtils>()),
  useTeamColor: () => (team: string) => COLORS[team],
}));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));

const { EventRules } = await import('~/components/Events/ScoredEvent/EventRules');

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

type Data = React.ComponentProps<typeof EventRules>['data'];
const page = {
  steps: [
    { title: 'Join', body: 'Get a team.' },
    { title: 'Hat your work', body: 'Place it.' },
    { title: 'Score', body: 'Views count.' },
  ],
  prize: { title: 'Champion badge', body: 'For the winning team.' },
  faq: [
    { question: 'Can I change teams?', answer: 'No.' },
    { question: 'What happens after?', answer: 'You keep them.' },
  ],
};
const rules = { reactionWeight: 10, viewerOwnerDailyCap: 50, newAccountDays: 7 };
const decoration = { entityTypes: ['Image'], moveCooldownMs: 10 * 60_000 };

function render(over: Record<string, unknown> = {}) {
  const data = {
    teams: ['Yellow', 'Blue', 'Pink', 'Green'],
    page,
    rules,
    decoration,
    ...over,
  } as unknown as Data;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      React.createElement(MantineProvider, null, React.createElement(EventRules, { data }))
    )
  );
  return host;
}

describe('How it works', () => {
  it('numbers the steps, each eyebrow in the next team colour', () => {
    const steps = render().querySelector('ol[data-testid="event-steps"]')!;
    const items = [...steps.children];
    expect(items.map((li) => [li.tagName, li.textContent])).toEqual([
      ['LI', 'Step 1JoinGet a team.'],
      ['LI', 'Step 2Hat your workPlace it.'],
      ['LI', 'Step 3ScoreViews count.'],
    ]);
    const eyebrows = items.map(
      (li) =>
        [...li.querySelectorAll<HTMLElement>('p')].find((p) => p.textContent?.startsWith('Step'))!
    );
    expect(eyebrows.map((p) => p.style.color)).toEqual([COLORS.Yellow, COLORS.Blue, COLORS.Pink]);
  });

  it('shows the points as figures: a view, a reaction at its weight, and your own', () => {
    const tiles = render().querySelector('[data-testid="event-points"]')!;
    expect([...tiles.children].map((t) => t.textContent)).toEqual([
      '1per view in a feed',
      '10per reaction',
      '0for your own views and reactions',
    ]);
  });

  it('lists the fairness rules with the event numbers, the cooldown only when there is one', () => {
    const fair = (el: HTMLElement) =>
      [...el.querySelectorAll('ul > li')].map((li) => li.textContent);
    const expected = [
      "One person counts for at most 50 of a creator's posts a day.",
      "Accounts made in the 7 days before the event don't count.",
      "Signed-out views count, up to a fair share. Bot-like browsing doesn't.",
      'A hat can move again 10 minutes after it was placed.',
      "Buzz spent doesn't score. Only attention does.",
    ];
    expect(fair(render())).toEqual(expected);
    act(() => root?.unmount());
    host?.remove();
    expect(fair(render({ decoration: { ...decoration, moveCooldownMs: 0 } }))).toEqual(
      expected.filter((r) => !r.startsWith('A hat can move'))
    );
  });

  it('puts the prize on its own banner', () => {
    expect(render().querySelector('[data-testid="event-prize"]')?.textContent).toBe(
      'The prizeChampion badgeFor the winning team.'
    );
  });

  // The site-wide `.mantine-Accordion-label { padding: 0 }` collapsed these rows to the text height.
  it('gives every question row its own vertical padding', () => {
    const faq = render().querySelector('[data-testid="event-faq"]')!;
    const controls = [...faq.querySelectorAll<HTMLElement>('.mantine-Accordion-control')];
    expect(controls.map((c) => c.textContent)).toEqual([
      'Can I change teams?',
      'What happens after?',
    ]);
    controls.forEach((c) => expect(c.style.paddingBlock).toBe('12px'));
  });

  it('gives no card a hover or spotlight state', () => {
    const el = render();
    expect(el.innerHTML).not.toMatch(/hover:/);
    const spotlit = [...el.querySelectorAll<HTMLElement>('*')].filter((n) =>
      n.style.getPropertyValue('--spotlight-opacity')
    );
    expect(spotlit).toHaveLength(0);
    // The questions are the one interactive part, and they are buttons.
    expect([...el.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Can I change teams?',
      'What happens after?',
    ]);
  });
});
