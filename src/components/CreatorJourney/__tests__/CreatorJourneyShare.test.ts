// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';

// The site share popover needs the app's providers; what it is handed is what this file checks.
vi.mock('~/components/ShareButton/ShareButton', () => ({
  ShareButton: ({ url, title, children }: { url: string; title: string; children: never }) =>
    React.createElement('span', { 'data-share-url': url, 'data-share-title': title }, children),
}));
const openProfileEdit = vi.hoisted(() => vi.fn());
vi.mock('~/components/Dialog/triggers/user-profile-edit', () => ({
  openUserProfileEditModal: openProfileEdit,
}));

import { CreatorJourneyView } from '~/components/CreatorJourney/CreatorJourney';

const act = (React as unknown as { act: typeof actType }).act;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Journey = React.ComponentProps<typeof CreatorJourneyView>['journey'];
type Earned = Journey['earned'][number];

const badge = (key: string, name: string, track = 'score'): Earned => ({
  key,
  track,
  threshold: 500,
  name,
  description: null,
  badgeUrl: track === 'score' ? null : 'https://example.test/badge.png',
  achievedAt: new Date('2026-10-06T00:00:00Z'),
});

const EARNED = [
  badge('score:spark', 'Spark'),
  badge('score:supernova', 'Supernova'),
  badge('create:models-1', 'First Model', 'create'),
  badge('reach:downloads-10000', '10k Downloads', 'reach'),
  badge('hidden:vwjxua', 'Number One', 'hidden'),
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;

type Share = { shareable?: string[]; hiddenOnProfile?: string[]; secret?: string[] };

function mountShelf(share: Share, username?: string) {
  const journey = {
    scores: null,
    unlocks: [],
    tiers: [],
    earned: EARNED,
    activity: { milestones: [], closestNext: null },
    secrets: [],
    share: { shareable: [], hiddenOnProfile: [], secret: [], ...share },
  } as unknown as Journey;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CreatorJourneyView, { journey, username })
      )
    )
  );
  return container;
}

function shareLinks(shareable: string[], username?: string, secret: string[] = []) {
  const shelf = mountShelf({ shareable, secret }, username);
  return [...shelf.querySelectorAll('[data-share-url]')].map((el) => ({
    url: el.getAttribute('data-share-url'),
    title: el.getAttribute('data-share-title'),
    label: el.querySelector('button')?.getAttribute('aria-label'),
  }));
}

const hiddenHints = (shelf: HTMLElement) =>
  [...shelf.querySelectorAll('button[aria-label$="is hidden on your profile"]')].map((el) =>
    el.getAttribute('aria-label')
  );

function unmount() {
  act(() => root?.unmount());
  container?.remove();
}

afterEach(unmount);

describe('share buttons on the journey shelf', () => {
  it('offers a share link only for milestones whose card renders', () => {
    expect(shareLinks(['score:supernova'], 'maker')).toEqual([
      {
        url: '/user/maker?milestone=supernova',
        title: 'I reached Supernova on Civitai',
        label: 'Share Supernova',
      },
    ]);
  });

  it('links an achievement by its key, and says it was earned', () => {
    expect(shareLinks(['reach:downloads-10000'], 'maker')).toEqual([
      {
        url: '/user/maker?milestone=reach:downloads-10000',
        title: 'I earned 10k Downloads on Civitai',
        label: 'Share 10k Downloads',
      },
    ]);
  });

  // Decided with Justin: a shared special keeps its secret. The share text is posted for strangers,
  // so it must not carry the name the card masks.
  it('keeps a special achievement secret in the share text', () => {
    const [link] = shareLinks(['hidden:vwjxua'], 'maker', ['hidden:vwjxua']);
    expect(link.url).toBe('/user/maker?milestone=hidden:vwjxua');
    expect(link.title).toBe('I unlocked a secret achievement on Civitai');
  });

  // Which milestones are secret is the server's answer (the `hidden` column the profile masks by),
  // not a guess from the key: a secret whose key looks ordinary is masked all the same.
  it('masks whatever the server marks secret, whatever its key', () => {
    const [link] = shareLinks(['create:models-1'], 'maker', ['create:models-1']);
    expect(link.title).toBe('I unlocked a secret achievement on Civitai');
  });

  it('names a milestone the server does not mark secret, whatever its key', () => {
    const [link] = shareLinks(['hidden:vwjxua'], 'maker', []);
    expect(link.title).toBe('I earned Number One on Civitai');
  });

  // Order is the shelf's own (badge-order.ts has its tests); this pins one button per shareable badge.
  it('offers one per shareable milestone, tiers and achievements alike', () => {
    expect(
      shareLinks(['score:spark', 'create:models-1', 'score:supernova'], 'maker')
        .map((link) => link.label)
        .sort()
    ).toEqual(['Share First Model', 'Share Spark', 'Share Supernova']);
  });

  it('offers nothing when nothing is shareable, or there is no username to link to', () => {
    expect(shareLinks([], 'maker')).toEqual([]);
    unmount();
    expect(shareLinks(['score:supernova'])).toEqual([]);
  });
});

// A tester hid tier badges on their profile and read the vanished share button as share being broken.
describe('unhide-to-share hint on the journey shelf', () => {
  it('stands where the share button would, on each badge hidden on the profile', () => {
    const shelf = mountShelf(
      { shareable: ['score:spark'], hiddenOnProfile: ['score:supernova', 'create:models-1'] },
      'maker'
    );
    expect(hiddenHints(shelf)).toEqual([
      'Supernova is hidden on your profile',
      'First Model is hidden on your profile',
    ]);
    expect(shelf.querySelectorAll('[data-share-url]')).toHaveLength(1);
  });

  it('opens the profile editor, where badges are unhidden', async () => {
    const shelf = mountShelf({ hiddenOnProfile: ['score:supernova'] }, 'maker');
    const chip = shelf.querySelector<HTMLButtonElement>(
      'button[aria-label="Supernova is hidden on your profile"]'
    );
    act(() => chip?.click());
    const unhide = await vi.waitFor(() => {
      const link = [...document.querySelectorAll('button')].find(
        (el) => el.textContent === 'Unhide it'
      );
      if (!link) throw new Error('popover not open');
      return link;
    });
    act(() => unhide.click());
    expect(openProfileEdit).toHaveBeenCalledTimes(1);
  });

  it('shows no hint when no badge is hidden', () => {
    expect(hiddenHints(mountShelf({ shareable: ['score:spark'] }, 'maker'))).toEqual([]);
  });
});
