import { describe, expect, it } from 'vitest';
import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '~/__tests__/mocks/db.mock';
import { measureHref } from '~/components/CreatorJourney/CreatorAchievements';
import {
  isAppPath,
  LinkedText,
  rewardLinks,
  unlockLinks,
  unlockLinksFor,
} from '~/components/CreatorJourney/journey-links';
import { tierRewards } from '~/components/CreatorJourney/tier-rewards';
import {
  buildCreatorScoreUnlocks,
  compiledCreatorScoreUnlockInputs,
} from '~/server/services/creator-score-unlocks.service';
import { groupCreatorScoreUnlocks } from '~/shared/utils/creator-score-unlocks';

const registry = buildCreatorScoreUnlocks(compiledCreatorScoreUnlockInputs);
const family = (key: string) => key.split(':')[0];

// Unlocks with no page to send a creator to. Adding an unlock to the registry fails the test below
// until it is either linked in `unlockLinks` or listed here on purpose.
const UNLINKED = ['comment-rate-limit', 'reaction-rate-limit'];

// MantineProvider prepends a <style> block; drop it, then the tags, to read what a person sees.
const visibleText = (html: string) =>
  html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
const render = (text: string, links: Parameters<typeof LinkedText>[0]['links']) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(LinkedText, { text, links }))
  );

describe('journey ladder links', () => {
  it('decides a link for every unlock family in the registry', () => {
    const families = [...new Set(registry.map((unlock) => family(unlock.key)))];
    expect(families.filter((key) => !unlockLinks[key] && !UNLINKED.includes(key))).toEqual([]);
    expect(Object.keys(unlockLinks).filter((key) => !families.includes(key))).toEqual([]);
  });

  // A phrase that drifts out of its label renders as plain text without complaint, so pin it here.
  it('finds every linked phrase in the label it links, as the ladder groups them', () => {
    const missing = groupCreatorScoreUnlocks(registry).flatMap((group) =>
      unlockLinksFor(group.key)
        .filter((link) => link.phrase && !group.label.includes(link.phrase))
        .map((link) => `${group.label} -> ${link.phrase}`)
    );
    expect(missing).toEqual([]);
  });

  it('links each phrase of "Create challenges and crucibles" to its own create page', () => {
    const label = registry.find((unlock) => unlock.key === 'challenge-create')?.label ?? '';
    const html = render(label, unlockLinksFor('challenge-create'));
    expect(hrefs(html)).toEqual(['/challenges/create', '/crucibles/create']);
    expect(visibleText(html)).toBe(label);
  });

  it('links the Creator Showcase and the profile from the tier rewards', () => {
    const rewards = Object.values(tierRewards).flat() as string[];
    const linked = rewards.flatMap((reward) => hrefs(render(reward, rewardLinks('alice'))));
    expect(linked.filter((href) => href === '/creators/showcase')).toHaveLength(2);
    expect(linked).toContain('/user/alice');
  });

  it('leaves the profile unlinked when there is no username', () => {
    const linked = (Object.values(tierRewards).flat() as string[]).flatMap((reward) =>
      hrefs(render(reward, rewardLinks()))
    );
    expect(linked.filter((href) => href.startsWith('/user/'))).toEqual([]);
  });

  it('sends each unlock to its page', () => {
    const studio = 'https://creator-studio.civitai.com';
    expect(
      Object.fromEntries(
        Object.entries(unlockLinks).map(([key, links]) => [key, links.map((link) => link.href)])
      )
    ).toEqual({
      'crucible-judge': ['/crucibles'],
      'daily-posts': ['/posts/create'],
      'daily-articles': ['/articles/create'],
      'challenge-create': ['/challenges/create', '/crucibles/create'],
      'monetize-pricing': [`${studio}/models`],
      'monetize-sales': [`${studio}/sales`],
      'early-access-days': [`${studio}/models`],
      'early-access-quantity': [`${studio}/models`],
      announcements: [`${studio}/announcements`],
      'placement-price-cap': ['/user/placements'],
      'placement-free-slots': ['/user/placements'],
      'creator-program': ['/creator-program'],
    });
  });

  it('opens Creator Studio in a new tab and keeps app paths in the tab', () => {
    const external = render('Run sales on your model versions', unlockLinksFor('monetize-sales'));
    expect(external).toMatch(/target="_blank"/);
    expect(external).toMatch(/rel="noreferrer"/);
    const internal = render('Judge crucibles', unlockLinksFor('crucible-judge'));
    expect(internal).not.toMatch(/target=/);
    expect(isAppPath('/crucibles')).toBe(true);
    expect(isAppPath('//evil.example/x')).toBe(false);
    // A protocol-relative href leaves the site, so it must render as an external link.
    expect(render('Leave', [{ href: '//evil.example/x' }])).toMatch(/target="_blank"/);
  });

  it('links phrases in text order whatever order the links are listed, skipping an overlap', () => {
    const html = render('Create challenges and crucibles', [
      { phrase: 'crucibles', href: '/b' },
      { phrase: 'challenges', href: '/a' },
      { phrase: 'challenges and', href: '/overlap' },
    ]);
    expect(hrefs(html)).toEqual(['/a', '/b']);
    expect(visibleText(html)).toBe('Create challenges and crucibles');
  });

  it('leaves the line whole and unlinked when a phrase is absent', () => {
    const html = render('Higher comment limits', [{ phrase: 'crucibles', href: '/crucibles' }]);
    expect(hrefs(html)).toEqual([]);
    expect(visibleText(html)).toBe('Higher comment limits');
  });
});

describe('achievement row links', () => {
  it('links rows to where the work happens, and only votes without a username', () => {
    const measures = [
      'models',
      'articles',
      'downloads',
      'followers',
      'reactions',
      'revenue',
      'votes',
    ] as const;
    const table = (username?: string) =>
      Object.fromEntries(measures.map((measure) => [measure, measureHref(measure, username)]));
    expect(table('alice')).toEqual({
      models: '/user/alice/models',
      articles: '/user/alice/articles',
      downloads: undefined,
      followers: undefined,
      reactions: undefined,
      revenue: '/user/alice/shop',
      votes: '/crucibles',
    });
    expect(table()).toEqual({
      models: undefined,
      articles: undefined,
      downloads: undefined,
      followers: undefined,
      reactions: undefined,
      revenue: undefined,
      votes: '/crucibles',
    });
  });
});
