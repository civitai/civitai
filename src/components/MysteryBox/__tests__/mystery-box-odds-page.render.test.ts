// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The public odds page as a visitor reads it: one team's base odds and contents at a time, how the
 * draw works, and the history, worded by the server.
 */

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({
  EdgeMedia: ({ src }: { src: string }) => React.createElement('img', { 'data-src': src }),
}));
vi.mock('~/components/Events/events.utils', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTeamColor: () => () => '#339af0',
}));

import { MysteryBoxOddsPage } from '../MysteryBoxOddsPage';
import type { MysteryBoxOddsPageData } from '../mystery-box.utils';
import { mysteryBoxOddsPageUrl } from '../mystery-box.utils';

const COMMON = 7;
const RARE = 6;
const content = (contentId: number, tierId: number, team: string | null) => ({
  contentId,
  tierId,
  cosmeticId: 1000 + contentId,
  name: `Hat ${contentId}`,
  url: `hat-${contentId}.png`,
  fit: null,
  team,
});
const page = (overrides: Partial<MysteryBoxOddsPageData> = {}): MysteryBoxOddsPageData => ({
  boxDefinitionId: 9,
  name: 'Birthday Box',
  description: null,
  version: 2,
  archived: false,
  noun: 'hat',
  event: { title: "Civitai's 4th Birthday" },
  teams: ['Blue', 'Pink'],
  price: 500,
  tiers: [
    { id: COMMON, key: 'common', name: 'Common', color: null, weight: 3, sortOrder: 0 },
    { id: RARE, key: 'rare', name: 'Rare', color: '#3b82f6', weight: 1, sortOrder: 1 },
  ],
  contents: [
    content(1, COMMON, 'Pink'),
    content(2, COMMON, 'Pink'),
    content(3, COMMON, 'Blue'),
    content(4, RARE, 'Pink'),
    content(5, RARE, null),
  ],
  history: [
    { version: 2, createdAt: new Date('2026-11-10T10:00:00Z'), changes: ['Rare weight 2 → 1.'] },
    {
      version: 1,
      createdAt: new Date('2026-11-06T10:00:00Z'),
      changes: ['Published: 5 hats, weights 3 / 2 (Common / Rare).'],
    },
  ],
  historyComplete: true,
  ...overrides,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onTeamChange = vi.fn();
const render = async (data: MysteryBoxOddsPageData, team?: string) => {
  await act(async () =>
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(MysteryBoxOddsPage, { page: data, team, onTeamChange })
      )
    )
  );
};
const rows = (testId: string) =>
  [...container.querySelectorAll(`[data-testid="${testId}"] tbody tr`)].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())
  );
const meta = () => container.querySelector('[data-testid="box-odds-meta"]')?.textContent;
const hatsShown = () =>
  [...container.querySelectorAll('[data-testid="box-tier"] [title]')].map((el) =>
    el.getAttribute('title')
  );

beforeEach(() => {
  onTeamChange.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MysteryBoxOddsPage', () => {
  it("shows one team's base odds and only the hats that team can draw", async () => {
    await render(page(), 'Pink');
    expect(rows('box-odds-table')).toEqual([
      ['Rare', '25%', '2', '13%'],
      ['Common', '75%', '2', '38%'],
    ]);
    expect(hatsShown()).toEqual(['Hat 4', 'Hat 5', 'Hat 1', 'Hat 2']);
    expect(container.textContent).toContain('Showing Team Pink.');
    expect(container.textContent).toContain(
      "Weights: Common 3 · Rare 1. A rarity's chance is its weight divided by the total weight"
    );
  });

  it("shows the box's description", async () => {
    await render(page({ description: 'A hat from your team.' }), 'Pink');
    expect(container.textContent).toContain('A hat from your team.');
  });

  it('falls back to the first team for a team the box has nothing for', async () => {
    await render(page(), 'Green');
    expect(container.textContent).toContain('Showing Team Blue.');
    expect(hatsShown()).toEqual(['Hat 5', 'Hat 3']);
  });

  it('asks to switch team when another is picked', async () => {
    await render(page(), 'Blue');
    const pink = [...container.querySelectorAll('label')].find((l) => l.textContent === 'Pink');
    await act(async () => pink!.click());
    expect(onTeamChange).toHaveBeenCalledWith('Pink');
  });

  it('shows the whole box, with no team picker, for a box without teams', async () => {
    await render(page({ teams: [], event: null }));
    expect(container.textContent).not.toContain('Showing Team');
    expect(hatsShown()).toHaveLength(5);
  });

  it('lists the history newest first, as the server worded it', async () => {
    await render(page(), 'Blue');
    expect(rows('box-odds-history')).toEqual([
      ['2', 'Nov 10, 2026', 'Rare weight 2 → 1.'],
      ['1', 'Nov 6, 2026', 'Published: 5 hats, weights 3 / 2 (Common / Rare).'],
    ]);
    expect(container.querySelector('[data-testid="box-odds-history-incomplete"]')).toBeNull();
  });

  it('heads the page with the version, first publish, last update, price and event', async () => {
    await render(page(), 'Blue');
    expect(meta()).toBe(
      "Version 2 · published Nov 6, 2026 · updated Nov 10, 2026 · 500 Buzz · Civitai's 4th Birthday"
    );
  });

  it('heads a first version with its publish only, and an unsold archived box with no price', async () => {
    await render(
      page({ version: 1, history: page().history.slice(1), price: null, archived: true })
    );
    expect(meta()).toBe(
      "Version 1 · published Nov 6, 2026 · Civitai's 4th Birthday · no longer sold"
    );
  });

  it('says when the latest change is missing from the history', async () => {
    await render(page({ historyComplete: false }), 'Blue');
    expect(
      container.querySelector('[data-testid="box-odds-history-incomplete"]')?.textContent
    ).toContain("The latest change to this box isn't in the history yet.");
  });

  it('shows one team without a picker, still only its own hats', async () => {
    await render(page({ teams: ['Pink'] }), 'Pink');
    expect(container.querySelector('.mantine-SegmentedControl-root')).toBeNull();
    expect(hatsShown()).toEqual(['Hat 4', 'Hat 5', 'Hat 1', 'Hat 2']);
  });
});

describe('mysteryBoxOddsPageUrl', () => {
  it("links to the viewer's team, and to the box alone without one", () => {
    expect(mysteryBoxOddsPageUrl({ boxDefinitionId: 9, team: 'Pink' })).toBe(
      '/mystery-boxes/9?team=Pink'
    );
    expect(mysteryBoxOddsPageUrl({ boxDefinitionId: 9, team: undefined })).toBe('/mystery-boxes/9');
  });
});
